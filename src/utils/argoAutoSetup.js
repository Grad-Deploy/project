// ════════════════════════════════════════════════════════
//  Grad-Deploy v2  ·  ArgoCD 자동 연동 모듈
//
//  목적: 사용자가 ArgoCD UI에서 수동으로 해야 했던
//        ① Repository 등록
//        ② Application 생성
//        ③ Sync 트리거
//        를 ArgoCD REST API 직접 호출로 자동화한다.
//
//  전제:
//    - ArgoCD가 minikube에 이미 떠 있고
//    - ngrok 또는 외부 URL로 접근 가능
//    - 사용자가 ArgoCD URL + admin 비번(또는 API 토큰)을 입력해 둠
//
//  보안 참고:
//    - ngrok 도메인은 Let's Encrypt 인증서를 갖고 있어 fetch에서
//      별도 처리 불필요 (브라우저는 정상 검증)
//    - ArgoCD가 자체 서명 인증서를 쓰는 환경이라도 ngrok이 TLS 종료점
//      이므로 브라우저 fetch 입장에선 문제 없음
// ════════════════════════════════════════════════════════

// ── URL 정규화 ──────────────────────────────────────────
// 사용자가 https:// 빠뜨리거나 trailing slash 붙여도 안전하게 처리
function normalizeArgoUrl(url) {
  if (!url) throw new Error('Argo CD 서버 URL이 비어 있습니다')
  let u = url.trim().replace(/\/+$/, '')  // trailing slash 제거
  if (!/^https?:\/\//.test(u)) u = `https://${u}`
  return u
}

// ── CORS 우회 Proxy 헬퍼 ────────────────────────────────
// ArgoCD 는 외부 origin 의 API 호출을 위한 CORS 헤더를 보내지 않아
// 브라우저에서 직접 호출하면 preflight 단계에서 차단됩니다.
//
// 해결: Vite dev server 의 /argocd-api proxy 를 경유.
//   - 브라우저 입장: same-origin 호출 (localhost:5173) → CORS 검사 안 일어남
//   - Vite proxy: 서버↔서버로 ArgoCD 에 forward (CORS 무관)
//
// 이 헬퍼는 fetch 의 url, headers 를 dev 환경에 맞게 변환합니다.
//   원본:  fetch('https://argocd.example.com/api/v1/session', { headers: H })
//   변환:  fetch('/argocd-api/api/v1/session', {
//            headers: { ...H, 'X-Argocd-Target': 'https://argocd.example.com' }
//          })
//
// production 빌드(import.meta.env.PROD === true)에선 변환 없이 직접 호출 —
// production 배포 시점엔 ArgoCD 와 same-origin 으로 서빙되거나
// 별도 backend proxy 가 있다고 가정.
function argoFetch(serverUrl, pathOrFullUrl, init = {}) {
  const normalized = normalizeArgoUrl(serverUrl)

  // pathOrFullUrl 가 절대 URL (e.g. 호환성 위해 normalized + path 로 들어온 경우)
  // 인지, 단순 path 인지 판별
  let path
  if (pathOrFullUrl.startsWith(normalized)) {
    path = pathOrFullUrl.slice(normalized.length)
  } else if (pathOrFullUrl.startsWith('/')) {
    path = pathOrFullUrl
  } else {
    path = `/${pathOrFullUrl}`
  }

  // Vite dev 환경: proxy 사용
  // - import.meta.env.DEV 는 Vite 가 주입하는 환경변수
  // - 빌드 산출물에선 false 가 되어 직접 호출 경로로 떨어짐
  if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV) {
    return fetch(`/argocd-api${path}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        'X-Argocd-Target': normalized,   // proxy 가 이 헤더를 읽어 ArgoCD 로 forward
      },
    })
  }

  // production: 직접 호출 (CORS 가 해결되어 있다고 가정)
  return fetch(`${normalized}${path}`, init)
}

// ── ArgoCD 세션 토큰 획득 ───────────────────────────────
// admin 계정 + 비밀번호로 단기 세션 토큰 발급
// (이미 토큰을 가진 경우엔 이 단계 스킵 가능)
export async function argoLogin(serverUrl, username, password) {
  let res
  try {
    res = await argoFetch(serverUrl, '/api/v1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
  } catch (e) {
    throw new Error(
      `Argo CD 서버 연결 실패: ${e.message}. cloudflared URL 이 활성 상태인지 확인하세요.`
    )
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Argo CD 인증 실패 (${res.status}): ${err.message || 'admin 계정 정보를 확인하세요'}`)
  }
  const { token } = await res.json()
  if (!token) throw new Error('Argo CD가 토큰을 반환하지 않았습니다')
  return token
}

// ── Repository 등록 ─────────────────────────────────────
// 이미 등록되어 있으면 PUT으로 업데이트, 없으면 POST로 생성
//
// GitHub PAT을 password로 사용하여 private repo도 접근 가능하게 함
// (public repo여도 무방, 단지 username/password 무시됨)
export async function argoRegisterRepo(serverUrl, argoToken, repoUrl, ghUser, ghPat) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${argoToken}`,
  }

  // 1) 기존 등록 여부 확인
  // GET /api/v1/repositories/{repo} — repo URL은 URL-encode 필요
  const repoEncoded = encodeURIComponent(repoUrl)
  let exists = false
  try {
    const check = await argoFetch(serverUrl, `/api/v1/repositories/${repoEncoded}`, { headers })
    exists = check.ok
  } catch (_) { /* 첫 등록일 가능성 */ }

  const body = JSON.stringify({
    repo: repoUrl,
    type: 'git',
    name: repoUrl.split('/').slice(-2).join('-'),  // owner-reponame 형식
    username: ghUser,
    password: ghPat,
    insecure: false,
    enableLfs: false,
  })

  const endpoint = exists
    ? `/api/v1/repositories/${repoEncoded}`
    : `/api/v1/repositories`
  const method = exists ? 'PUT' : 'POST'

  const res = await argoFetch(serverUrl, endpoint, { method, headers, body })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    // 409 = 이미 존재 (성공으로 간주)
    if (res.status === 409) return { ok: true, existing: true }
    throw new Error(
      `Repository 등록 실패 (${res.status}): ${err.message || err.error || ''}`
    )
  }
  return { ok: true, existing: exists }
}

// ── Application 생성 ────────────────────────────────────
// path: k8s/projects/${proj}/overlays/production (kustomize overlay 위치)
// 이미 존재하면 PUT으로 업데이트, 없으면 POST로 생성
//
// upsert=true 옵션을 사용해 단일 호출로 생성/업데이트 모두 처리
export async function argoCreateOrUpdateApp(serverUrl, argoToken, cfg) {
  const {
    appName,
    proj,            // ApplicationSet과 동일한 project name
    repoUrl,
    ns,
    targetRevision = 'HEAD',
    path,            // k8s/projects/${proj}/overlays/production
  } = cfg

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${argoToken}`,
  }

  // AppProject 이름은 genAppProject()에서 '${proj}-project' 규칙으로 생성됨
  // (k8s_improved.js 의 genAppProject 참조)
  const projectName = `${proj}-project`

  const appManifest = {
    metadata: {
      name: appName,
      namespace: 'argocd',
      finalizers: ['resources-finalizer.argocd.argoproj.io'],
    },
    spec: {
      project: projectName,
      source: {
        repoURL: repoUrl,
        targetRevision,
        path,
      },
      destination: {
        server: 'https://kubernetes.default.svc',
        namespace: ns,
      },
      syncPolicy: {
        automated: {
          prune: true,
          selfHeal: true,
        },
        syncOptions: [
          'CreateNamespace=true',
          'PrunePropagationPolicy=foreground',
          'ServerSideApply=true',
        ],
        retry: {
          limit: 5,
          backoff: { duration: '5s', factor: 2, maxDuration: '3m' },
        },
      },
    },
  }

  // upsert=true: 존재하면 update, 없으면 create
  // 단일 호출로 멱등성 보장 → 같은 배포 버튼을 여러 번 눌러도 안전
  const res = await argoFetch(
    serverUrl,
    `/api/v1/applications?upsert=true`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(appManifest),
    }
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Application 생성/업데이트 실패 (${res.status}): ${err.message || err.error || ''}`
    )
  }
  return { ok: true, appName }
}

// ── AppProject 존재 확인 ────────────────────────────────
// Application 생성 전에 AppProject가 클러스터에 적용되어 있어야 함
//
// k8s_improved.js의 genAppProject가 생성하는 YAML은 ArgoCD가 자동 sync
// 하기 전엔 클러스터에 없을 수 있음 → 사전 체크해서 부드러운 에러 메시지 제공
export async function argoCheckProject(serverUrl, argoToken, proj) {
  const projectName = `${proj}-project`

  const res = await argoFetch(serverUrl, `/api/v1/projects/${projectName}`, {
    headers: { Authorization: `Bearer ${argoToken}` },
  })
  return res.ok
}

// ── Application Sync 강제 트리거 ────────────────────────
// 생성 직후 자동 sync가 시작되지만, 즉시 결과를 보고 싶을 때 명시 트리거
// (선택 사항 — automated.selfHeal가 결국 동기화함)
export async function argoTriggerSync(serverUrl, argoToken, appName) {
  const res = await argoFetch(
    serverUrl,
    `/api/v1/applications/${appName}/sync`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${argoToken}`,
      },
      body: JSON.stringify({
        prune: true,
        strategy: { hook: { force: false } },
        syncOptions: ['CreateNamespace=true'],
      }),
    }
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    // 404 = 앱 생성 직후 아직 인덱싱 안됐을 수 있음 — 무해
    if (res.status === 404) return { ok: false, skipped: true }
    throw new Error(`Sync 트리거 실패 (${res.status}): ${err.message || ''}`)
  }
  return { ok: true }
}

// ════════════════════════════════════════════════════════
//  통합 함수: 한 번의 호출로 전체 자동화 수행
// ════════════════════════════════════════════════════════
/**
 * ArgoCD 전체 자동 설정 (handleDeploy에서 한 번에 호출)
 *
 * @param {object} cfg
 * @param {string} cfg.argoServerUrl  - "https://xxx.ngrok-free.app" or "https://xxx.trycloudflare.com"
 * @param {string} cfg.argoUser       - "admin"
 * @param {string} cfg.argoPassword   - admin 비밀번호 (또는 argoToken 직접 사용 시 생략)
 * @param {string} [cfg.argoToken]    - 기존 토큰 있으면 우선 사용
 * @param {string} cfg.repoUrl        - "https://github.com/owner/repo"
 * @param {string} cfg.ghUser         - GitHub 계정 (Repository 접근용)
 * @param {string} cfg.ghPat          - GitHub PAT (private repo 접근용)
 * @param {string} cfg.proj           - 프로젝트명
 * @param {string} cfg.ns             - 네임스페이스
 * @param {boolean} [cfg.triggerSync] - 즉시 sync 호출 여부 (default: true)
 * @param {function} [cfg.onTokenObtained] - 토큰 발급 후 GitHub Secrets/Variables 등록 콜백
 *                                            async ({ argoToken, argoServerHost }) => void
 * @returns {object} { steps: [...], appName, argoUrl }
 */
export async function argoAutoSetup(cfg) {
  const {
    argoServerUrl,
    argoUser = 'admin',
    argoPassword,
    argoToken: existingToken,
    repoUrl,
    ghUser,
    ghPat,
    proj,
    ns,
    triggerSync = true,
    onTokenObtained,
  } = cfg

  const steps = []
  const recordStep = (name, ok, detail = '') => {
    steps.push({ name, ok, detail })
  }

  // ── Step 1: 토큰 확보 ─────────────────────────────
  let token = existingToken
  if (!token) {
    if (!argoPassword) {
      throw new Error('Argo CD 토큰 또는 admin 비밀번호 중 하나가 필요합니다')
    }
    try {
      token = await argoLogin(argoServerUrl, argoUser, argoPassword)
      recordStep('Argo CD 로그인', true, `${argoUser} 계정으로 토큰 발급`)
    } catch (e) {
      recordStep('Argo CD 로그인', false, e.message)
      return { steps, ok: false, error: e.message }
    }
  } else {
    recordStep('Argo CD 토큰', true, '기존 토큰 사용')
  }

  // ── Step 1.5: GitHub Secrets/Variables 자동 등록 ─────
  // 발급된 토큰을 GitHub Repository Secret으로 저장하여
  // GitHub Actions의 update-manifests job에서 ARGOCD_TOKEN 으로 사용 가능하게 함
  // (하드코딩 대신 sealed box 암호화 저장)
  if (onTokenObtained) {
    try {
      const argoServerHost = normalizeArgoUrl(argoServerUrl).replace(/^https?:\/\//, '')
      await onTokenObtained({ argoToken: token, argoServerHost })
      recordStep('GitHub Secrets 등록', true, 'ARGOCD_TOKEN + ARGOCD_SERVER 자동 저장')
    } catch (e) {
      // 등록 실패해도 fatal하지 않음 — 사용자에게 경고만
      recordStep('GitHub Secrets 등록', false,
        `${e.message} (GitHub Actions의 ArgoCD 호출은 동작하지 않을 수 있습니다)`)
    }
  }

  // ── Step 2: Repository 등록 ────────────────────────
  try {
    const r = await argoRegisterRepo(argoServerUrl, token, repoUrl, ghUser, ghPat)
    recordStep(
      'Repository 등록',
      true,
      r.existing ? `${repoUrl} (이미 등록됨, 업데이트 완료)` : `${repoUrl} (신규 등록)`
    )
  } catch (e) {
    recordStep('Repository 등록', false, e.message)
    return { steps, ok: false, error: e.message, argoToken: token }
  }

  // ── Step 3: AppProject 존재 확인 ──────────────────
  // 없으면 부드러운 경고 — 첫 배포 시엔 root-bootstrap이 먼저 sync되어야 함
  const hasProject = await argoCheckProject(argoServerUrl, token, proj).catch(() => false)
  recordStep(
    'AppProject 확인',
    hasProject,
    hasProject
      ? `${proj}-project 존재`
      : `${proj}-project 없음 — root bootstrap Application이 먼저 sync되어야 합니다`
  )

  // ── Step 4: Application 생성/업데이트 ──────────────
  // path: buildAllFiles와 k8s_improved.js의 overlayDir과 동일하게 맞춰야 함
  // → k8s/projects/${proj}/overlays/production
  const appPath = `k8s/projects/${proj}/overlays/production`
  let appName
  try {
    const r = await argoCreateOrUpdateApp(argoServerUrl, token, {
      appName: proj,            // genArgoCDApp()의 명명 규칙과 일치
      proj,
      repoUrl,
      ns,
      path: appPath,
    })
    appName = r.appName
    recordStep('Application 생성', true, `name=${appName}, path=${appPath}`)
  } catch (e) {
    recordStep('Application 생성', false, e.message)
    return { steps, ok: false, error: e.message, argoToken: token }
  }

  // ── Step 5: Sync 트리거 (선택) ─────────────────────
  if (triggerSync) {
    try {
      const r = await argoTriggerSync(argoServerUrl, token, appName)
      recordStep(
        'Sync 트리거',
        r.ok,
        r.skipped ? '앱이 아직 인덱싱 중 — 자동 sync가 곧 실행됩니다' : '동기화 시작됨'
      )
    } catch (e) {
      // sync 실패는 fatal하지 않음 — automated.selfHeal이 결국 동기화함
      recordStep('Sync 트리거', false, `${e.message} (automated sync로 대체됨)`)
    }
  }

  return {
    steps,
    ok: true,
    argoToken: token,
    appName,
    argoUrl: normalizeArgoUrl(argoServerUrl),
  }
}
