import { useState } from 'react'
import { Input, Btn } from './Ui'
import { SERVICE_TEMPLATES } from '../engines/guardrail'
import {
  buildAllFiles,                // ConfigMap·Secret·Deployment·Service·CI·ArgoCD 전체 파일 생성
  buildManifestYAML,            // 우측 YAML 미리보기 전용 (push에는 미사용)
  genNetworkPolicies,
  genGitHubActions,
  genArgoCDApp,
  genBaseKustomization,
  genOverlayKustomization,
  toK8sName,
} from '../generators/k8s_improved'
import { encryptForGithub } from '../utils/sealedBox'
import { argoAutoSetup } from '../utils/argoAutoSetup'

const FSM = [
  { q: 'q0', label: 'Draft', color: 'var(--t3)' },
  { q: 'q1', label: 'Validating', color: 'var(--amber)' },
  { q: 'q2', label: 'Committed', color: 'var(--blue)' },
  { q: 'q3', label: 'Deploying', color: 'var(--purple)' },
  { q: 'q4', label: 'Deployed ✓', color: 'var(--green)' },
]

// ════════ GitHub API 헬퍼 ════════════════════════════════

async function ghAuthCheck(pat) {
  const r = await fetch('https://api.github.com/user', {
    headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' },
  })
  if (!r.ok) throw new Error(`인증 실패 (${r.status}): PAT를 확인하세요`)
  return await r.json()
}

async function ghListRepos(pat) {
  const r = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator', {
    headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' },
  })
  if (!r.ok) throw new Error(`레포 목록 조회 실패 (${r.status})`)
  return await r.json()
}

async function ghCreateRepo(pat, name, isPrivate) {
  const r = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      Authorization: `token ${pat}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github.v3+json',
    },
    body: JSON.stringify({
      name,
      private: isPrivate,
      auto_init: true,
      description: 'Managed by Grad-Deploy',
    }),
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error(`레포 생성 실패 (${r.status}): ${err.message || ''}`)
  }
  return await r.json()
}

// 기존 ci.yml에서 build job 서비스명 추출
async function ghFetchExistingServices(pat, owner, repo) {
  try {
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows/ci.yml`,
      { headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' } }
    )
    if (!r.ok) return []
    const d = await r.json()
    const text = atob(d.content.replace(/\n/g, ''))
    // build-{name}: 패턴에서 서비스명 추출
    const matches = [...text.matchAll(/^  build-([\w-]+):/gm)]
    return matches.map(m => m[1])
  } catch (_) { return [] }
}

async function ghFetchExistingProjects(pat, owner, repo) {
  try {
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/k8s/projects`,
      { headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' } }
    )
    if (r.status === 404) return []
    if (!r.ok) {
      const err = await r.json().catch(() => ({}))
      throw new Error(`기존 프로젝트 목록 조회 실패 (${r.status}): ${err.message || ''}`)
    }
    const entries = await r.json()
    if (!Array.isArray(entries)) return []
    return entries.filter(e => e.type === 'dir').map(e => e.name)
  } catch (e) {
    throw new Error(`기존 repo 프로젝트 확인 실패: ${e.message}`)
  }
}

async function ghPushFiles(pat, owner, repo, files) {
  const base = `https://api.github.com/repos/${owner}/${repo}/contents`
  const results = []

  // 헬퍼: 일정 시간 대기
  const sleep = ms => new Promise(r => setTimeout(r, ms))

  for (const [path, content] of Object.entries(files)) {
    let lastError = null
    let success = false

    // 최대 3회 재시도 (409 Conflict 등 일시적 충돌 대비)
    // GitHub Contents API 는 동일 repo 에 빠른 연속 PUT 시
    // 내부 Git ref 갱신 전에 다음 요청이 들어와 409 를 반환할 수 있음.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // 1) 현재 파일의 SHA 조회 (기존 파일이면 갱신, 신규면 생성)
        let sha
        try {
          const r = await fetch(`${base}/${path}`, {
            headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' },
          })
          if (r.ok) { const d = await r.json(); sha = d.sha }
        } catch (_) { }

        // 2) PUT 으로 파일 업로드
        const r = await fetch(`${base}/${path}`, {
          method: 'PUT',
          headers: { Authorization: `token ${pat}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github.v3+json' },
          body: JSON.stringify({
            message: `chore: grad-deploy [${path}]`,
            content: btoa(unescape(encodeURIComponent(content))),
            ...(sha ? { sha } : {}),
          }),
        })

        if (r.ok) {
          results.push({ path, ok: true, status: r.status })
          success = true
          break
        }

        // 실패 응답 본문도 함께 수집해 사용자에게 노출
        const errBody = await r.json().catch(() => ({}))
        lastError = {
          path,
          ok: false,
          status: r.status,
          message: errBody.message || '',
          documentation_url: errBody.documentation_url || '',
        }

        // 409 Conflict 는 재시도 대상 (잠시 대기 후 재시도)
        // 422 Unprocessable Entity 는 SHA 불일치 — SHA 재조회를 위해 재시도
        if (r.status === 409 || r.status === 422) {
          await sleep(500 * (attempt + 1))   // 백오프: 500ms, 1000ms
          continue
        }

        // 그 외 에러는 즉시 실패 처리
        break
      } catch (e) {
        lastError = { path, ok: false, error: e.message }
        await sleep(500 * (attempt + 1))
      }
    }

    if (!success) {
      results.push(lastError || { path, ok: false, status: 'unknown' })
    }

    // GitHub Contents API 연속 호출 시 ref 갱신 race condition 회피
    // (특히 같은 디렉터리 내 파일들 사이)
    await sleep(150)
  }
  return results
}

// GitHub Secrets API
async function ghSetSecret(pat, owner, repo, secretName, secretValue) {
  if (!owner || !repo) throw new Error('레포가 선택되지 않았습니다. 먼저 배포 대상 레포를 선택하세요.')
  // 1. public key 조회
  const keyRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`, {
    headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' },
  })
  if (!keyRes.ok) throw new Error(`Public key 조회 실패 (${keyRes.status})`)
  const { key, key_id } = await keyRes.json()

  // 2. 값 암호화
  const encrypted_value = await encryptForGithub(key, secretValue)

  // 3. Secret 등록
  const setRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/${secretName}`, {
    method: 'PUT',
    headers: { Authorization: `token ${pat}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github.v3+json' },
    body: JSON.stringify({ encrypted_value, key_id }),
  })
  if (!setRes.ok) {
    const err = await setRes.json().catch(() => ({}))
    throw new Error(`Secret 등록 실패 [${secretName}] (${setRes.status}): ${err.message || ''}`)
  }
  return true
}

// Argo CD 세션 토큰 획득 (브라우저 → Argo CD API 직접 호출)
async function argoFetchToken(serverUrl, username, password) {
  let r
  try {
    r = await fetch(`${serverUrl}/api/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
  } catch {
    throw new Error(
      'Argo CD 서버에 연결할 수 없습니다. CORS 정책 또는 네트워크 문제일 수 있습니다. ' +
      '"토큰 직접 입력" 모드를 사용하세요.'
    )
  }
  if (!r.ok) {
    const json = await r.clone().json().catch(() => null)
    const parts = []
    if (json && typeof json === 'object') {
      if (json.error) parts.push(json.error)
      if (json.message && json.message !== json.error) parts.push(json.message)
      if (json.hint) parts.push(`hint: ${json.hint}`)
      if (json.target) parts.push(`target: ${json.target}`)
    }
    const text = parts.length === 0 ? (await r.clone().text().catch(() => '')).trim() : parts.join(' | ')
    const statusHint =
      r.status === 401 || r.status === 403
        ? 'admin 계정 또는 비밀번호를 확인하세요'
        : 'Argo CD 서버 URL, 프록시, 또는 project/repo 이름을 확인하세요'
    throw new Error(`Argo CD 요청 실패 (${r.status}): ${text || statusHint}`)
  }
  const { token } = await r.json()
  if (!token) throw new Error('서버에서 토큰을 받지 못했습니다')
  return token
}

// GitHub Actions Variable 생성/업데이트
async function ghSetVariable(pat, owner, repo, name, value) {
  if (!owner || !repo) throw new Error('레포가 선택되지 않았습니다. 먼저 배포 대상 레포를 선택하세요.')
  const base = `https://api.github.com/repos/${owner}/${repo}/actions/variables`
  const headers = { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' }

  const checkRes = await fetch(`${base}/${name}`, { headers })
  if (checkRes.status === 403 || checkRes.status === 404) {
    const errBody = await checkRes.json().catch(() => ({}))
    if (checkRes.status === 403) throw new Error(`Variable API 접근 거부 (403): PAT에 'repo' + 'workflow' 스코프가 필요합니다.`)
    // 404는 "변수 없음(신규)" 또는 "레포/권한 없음" 두 가지 경우가 있음
    // message 필드로 구분
    if (errBody.message && errBody.message !== 'Not Found') throw new Error(`Variable API 오류 (404): ${errBody.message}`)
  }
  const exists = checkRes.ok

  const r = await fetch(exists ? `${base}/${name}` : base, {
    method: exists ? 'PATCH' : 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(exists ? { value } : { name, value }),
  })
  // PATCH 성공 = 204 No Content (r.ok=false이지만 정상), POST 성공 = 201 Created
  if (r.status === 204 || r.status === 201) return true
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error(`Variable 설정 실패 [${name}] (${r.status}): ${err.message || ''}`)
  }
  return true
}

// GitHub Webhook 등록 (Argo CD Push 기반 즉시 Sync — US-03)
async function ghRegisterWebhook(pat, owner, repo, argocdServer) {
  const webhookUrl = `https://${argocdServer}/api/webhook`
  const base = `https://api.github.com/repos/${owner}/${repo}/hooks`
  const headers = {
    Authorization: `token ${pat}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  }

  // 기존 Webhook 목록 조회 → 중복 방지
  const listRes = await fetch(base, { headers })
  if (listRes.ok) {
    const hooks = await listRes.json()
    const existing = hooks.find(h => h.config?.url === webhookUrl)
    if (existing) return { created: false, existing: true, url: webhookUrl }
  }

  // Webhook 신규 등록
  const res = await fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'web',
      active: true,
      events: ['push'],
      config: {
        url: webhookUrl,
        content_type: 'json',
        insecure_ssl: '1',  // 자체 서명 인증서 허용
      },
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Webhook 등록 실패 (${res.status}): ${err.message || ''}`)
  }
  return { created: true, url: webhookUrl }
}

// ════════ 컴포넌트 ════════════════════════════════════════

export default function DeployPanel({ state, engineResult, set }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [repos, setRepos] = useState([])
  const [results, setResults] = useState(null)
  const [isAdvancedMode, setIsAdvancedMode] = useState(false) // [신규] Simple/Advanced 토글

  const {
    pat, ghUser, deployMode, selectedRepo, newRepoName, newRepoPrivate,
    services, registry, dockerhubUser, dockerhubToken,
  } = state

  // ── PAT 검증
  const verifyPat = async () => {
    if (!pat) return
    setError(null); setBusy(true)
    try {
      const user = await ghAuthCheck(pat)
      const repoList = await ghListRepos(pat)
      set({ ghUser: user })
      setRepos(repoList.map(r => ({
        full_name: r.full_name,
        name: r.name,
        owner: r.owner.login,
        private: r.private,
      })))
    } catch (e) {
      setError(e.message)
      set({ ghUser: null })
      setRepos([])
    } finally { setBusy(false) }
  }

  const resetPat = () => {
    set({ pat: '', ghUser: null, selectedRepo: '', newRepoName: '' })
    setRepos([])
    setError(null)
    setResults(null)
  }

  // ── 배포 실행
  const handleDeploy = async () => {
    setBusy(true); setError(null); setResults(null)

    try {
      // 0. SSO 설정 검증 (Advanced 모드일 때만)
      if (isAdvancedMode) {
        if (!state.ssoClientId || state.ssoClientId.trim() === '') {
          throw new Error('SSO 연동을 위한 OAuth App Client ID를 입력해야 합니다.')
        }
        if (!state.ssoTeams || state.ssoTeams.length === 0) {
          throw new Error('최소 1개 이상의 GitHub 팀과 역할(Role) 매핑을 추가해야 합니다.')
        }
      }

      // 1. 대상 레포 결정
      let owner, repo
      if (deployMode === 'create') {
        if (!newRepoName) throw new Error('새 레포명을 입력하세요')
        const created = await ghCreateRepo(pat, newRepoName, newRepoPrivate)
        owner = created.owner.login
        repo = created.name
      } else {
        if (!selectedRepo) throw new Error('레포를 선택하세요')
          ;[owner, repo] = selectedRepo.split('/')
      }
      // ── [수정] 대소문자 스트릭트 매칭 문제를 해결하기 위해 소문자 정규화 ──
      const repoUrl = `https://github.com/${owner}/${repo}`.toLowerCase();
      const rawRepoUrl = `https://raw.githubusercontent.com/${owner}/${repo}`.toLowerCase();
      const projectName = (state.proj || '').trim()
      const argoProjectName = toK8sName(projectName)

      if (!projectName) {
        throw new Error('프로젝트명을 입력하세요.')
      }

      if (deployMode === 'existing') {
        const existingProjects = await ghFetchExistingProjects(pat, owner, repo)
        const staleProjects = existingProjects.filter(p => p !== projectName && toK8sName(p) !== argoProjectName)
        if (staleProjects.length > 0) {
          throw new Error(
            [
              `기존 repo에 다른 Grad-Deploy 프로젝트가 남아 있습니다.`,
              `selected repo: ${owner}/${repo}`,
              `current project: ${projectName} (Argo/K8s name: ${argoProjectName})`,
              `existing projects: ${existingProjects.join(', ')}`,
              `hint: k8s/projects/${staleProjects[0]} 같은 이전 산출물을 삭제하거나, 프로젝트명을 기존 repo와 맞춘 뒤 다시 배포하세요.`,
            ].join(' ')
          )
        }
      }

      // 2. 기존 ci.yml에서 서비스 목록을 읽어 현재 서비스와 병합
      //    (2차 이후 push 시 이전 서비스 job이 사라지는 문제 방지)
      const existingSvcNames = await ghFetchExistingServices(pat, owner, repo)
      const currentSvcNames = new Set(services.map(s => s.name))
      const missingSvcNames = existingSvcNames.filter(n => !currentSvcNames.has(n))

      const missingServices = missingSvcNames.map(name => {
        const typeGuess = (() => {
          if (name.includes('spring')) return 'spring-boot'
          if (name.includes('mysql')) return 'mysql'
          if (name.includes('redis')) return 'redis'
          if (name.includes('mongo')) return 'mongodb'
          if (name.includes('next')) return 'nextjs'
          if (name.includes('node')) return 'node-backend'
          if (name.includes('python') || name.includes('flask')) return 'python-flask'
          if (name.includes('react') || name.includes('nginx')) return 'react-nginx'
          return 'node-backend'
        })()
        const t = SERVICE_TEMPLATES[typeGuess] || {}
        return {
          id: name, name, type: typeGuess, image: '', port: t.port || 8080,
          replicas: 1, cpuReq: t.cpuReq, memReq: t.memReq,
          cpuLim: t.cpuLim || '', memLim: t.memLim, hpa: false,
          deps: [], env: {}, expose: false,
        }
      })

      // buildAllFiles: ConfigMap·Secret·Deployment·Service·HPA·NetworkPolicy·CI·ArgoCD·.gitignore
      // kind 환경이면 Ingress·kind-config.yaml·로컬 레지스트리 스크립트도 포함
      const allServices = [...services, ...missingServices]
      const files = buildAllFiles(allServices, {
        ns: state.ns,
        proj: state.proj,
        repo: repoUrl,
        registry,
        dockerhubUser,
        cloud: state.cloud || 'kind',
        workerCount: state.kindWorkerCount || 2,
        useLocalRegistry: state.kindUseLocalRegistry || false,
        registryPort: state.kindRegistryPort || 5001,
        // SSO 파라미터 — SsoSetupSection 에서 입력받은 값을 state 에서 전달
        githubClientId: state.ssoClientId || import.meta.env.VITE_DEFAULT_SSO_CLIENT_ID || 'REPLACE_WITH_OAUTH_CLIENT_ID',
        argocdServer: state.argocdServer || import.meta.env.VITE_DEFAULT_ARGOCD_SERVER || 'argocd.example.com',
        ssoTeams: state.ssoTeams || [],
        // ── [신규] 사용자의 PAT 스펙을 엔진 매니페스트 생성기로 주입 ──
        pat:            state.pat,
        ghUserLogin:    ghUser.login, 
      })

      // missingServices는 CI용으로만 포함 — ConfigMap/Secret은 현재 서비스만 생성되어야 함
      // buildAllFiles가 allServices 기준으로 configmap을 만들기 때문에
      // missingServices의 빈 env는 configmap.yaml에 '# 설정값 없음'으로만 들어가서 무해함

      // 3. 파일 push
      const pushResults = await ghPushFiles(pat, owner, repo, files)
      const pushFailed = pushResults.some(r => !r.ok)

      if (pushFailed) {
        const firstFailure = pushResults.find(r => !r.ok)
        setResults({
          repo: `${owner}/${repo}`,
          files: pushResults,
          secrets: [],
          registry,
          pushOk: false,
          argoSetup: null,
          argoSetupError: [
            `파일 Push 실패: ${firstFailure?.path || 'unknown'}`,
            firstFailure?.status ? `(HTTP ${firstFailure.status})` : '',
            firstFailure?.message || firstFailure?.error || '',
            `GitHub PAT에 repo contents 쓰기 권한이 있는지 확인하세요.`,
          ].filter(Boolean).join(' '),
          argoServerUrl: state.argocdServer,
          bootstrapCmd: null,
          bootstrap: null,
          bootstrapError: null,
        })
        return
      }

      // 4. Docker Hub 모드면 Secrets 등록
      const secretsResults = []
      if (registry === 'dockerhub') {
        if (!dockerhubUser || !dockerhubToken) {
          throw new Error('Docker Hub 사용자명과 Access Token을 입력하세요')
        }
        try {
          await ghSetSecret(pat, owner, repo, 'DOCKERHUB_USERNAME', dockerhubUser)
          secretsResults.push({ name: 'DOCKERHUB_USERNAME', ok: true })
        } catch (e) {
          secretsResults.push({ name: 'DOCKERHUB_USERNAME', ok: false, error: e.message })
        }
        try {
          await ghSetSecret(pat, owner, repo, 'DOCKERHUB_TOKEN', dockerhubToken)
          secretsResults.push({ name: 'DOCKERHUB_TOKEN', ok: true })
        } catch (e) {
          secretsResults.push({ name: 'DOCKERHUB_TOKEN', ok: false, error: e.message })
        }
      }

      if (registry === 'ghcr') {
        try {
          await ghSetSecret(pat, owner, repo, 'PAT_TOKEN', pat)
          secretsResults.push({ name: 'PAT_TOKEN', ok: true, type: 'Secret (GHCR 로그인용)' })
        } catch (e) {
          secretsResults.push({ name: 'PAT_TOKEN', ok: false, error: e.message })
        }
      }

      // [추가] GitHub OAuth Client Secret 등록
      if (state.ssoClientSecret && state.ssoClientSecret.trim() !== '') {
        try {
          await ghSetSecret(pat, owner, repo, 'ARGOCD_CLIENT_SECRET', state.ssoClientSecret.trim())
          secretsResults.push({ name: 'ARGOCD_CLIENT_SECRET', ok: true, type: 'Secret (GitHub SSO용)' })
        } catch (e) {
          secretsResults.push({ name: 'ARGOCD_CLIENT_SECRET', ok: false, error: e.message, type: 'Secret' })
        }
      }

      // [Checkpoint 4] Next.js 빌드 시점 변수(NEXT_PUBLIC_)를 GitHub Variables에 자동 등록
      const buildTimeVars = []
      allServices.forEach(svc => {
        if (svc.type === 'nextjs') {
          Object.entries(svc.env || {}).forEach(([k, v]) => {
            if (k.startsWith('NEXT_PUBLIC_') && v && String(v).trim() !== '') {
              buildTimeVars.push({ name: k, value: String(v) })
            }
          })
        }
      })

      for (const btv of buildTimeVars) {
        try {
          await ghSetVariable(pat, owner, repo, btv.name, btv.value)
          secretsResults.push({ name: btv.name, ok: true, type: 'Variable (Next.js 빌드용)' })
        } catch (e) {
          secretsResults.push({ name: btv.name, ok: false, error: e.message, type: 'Variable' })
        }
      }

      // argoAutoSetup은 repoUrl을 사용함 (line 298에서 정의됨)

      // ── ArgoCD 자동 연동 ─────────────────────────────────
      // 사용자가 ArgoCD URL + admin 비밀번호(또는 토큰)를 입력했을 때만 시도
      // Repository 등록 + Application 생성 + Sync 트리거를 한 번에 수행
      let argoSetupResult = null
      let argoSetupError = null
      let bootstrapResult = null
      let bootstrapError = null

      const finalArgoServer = state.argocdServer || import.meta.env.VITE_DEFAULT_ARGOCD_SERVER
      const finalArgoUser = state.argocdUser || import.meta.env.VITE_DEFAULT_ARGOCD_USER || 'admin'
      const finalArgoPass = state.argocdAdminPassword || import.meta.env.VITE_DEFAULT_ARGOCD_PASSWORD
      const finalArgoToken = state.argocdToken || import.meta.env.VITE_DEFAULT_ARGOCD_TOKEN

      const canAutoArgo = finalArgoServer && (finalArgoPass || finalArgoToken)

      if (canAutoArgo) {
        // 로컬 kubectl 대신 Argo CD API로 AppProject/Repository/Application을
        // 직접 upsert한다. 클러스터가 VM에 있어도 Mac dev server 컨텍스트와
        // 무관하게 동작해야 한다.
        try {
          argoSetupResult = await argoAutoSetup({
            argoServerUrl: finalArgoServer,
            argoUser: finalArgoUser,
            argoPassword: finalArgoPass,
            argoToken: finalArgoToken,
            repoUrl,
            ghUser: ghUser.login,
            ghPat: pat,
            proj: state.proj,
            ns: state.ns || 'default',
            triggerSync: true,
            // ── 발급된 토큰을 GitHub Repository에 자동 등록 ───
            // 하드코딩 대신 sealed box로 암호화 저장 → GitHub Actions에서
            // secrets.ARGOCD_TOKEN, vars.ARGOCD_SERVER 로 안전하게 참조 가능
            onTokenObtained: async ({ argoToken, argoServerHost }) => {
              // 1) ArgoCD 토큰 → Secret (암호화 저장)
              await ghSetSecret(pat, owner, repo, 'ARGOCD_TOKEN', argoToken)
              // 2) ArgoCD 호스트 → Variable (평문 저장 — 민감하지 않음)
              await ghSetVariable(pat, owner, repo, 'ARGOCD_SERVER', argoServerHost)
            },
          })
          if (!argoSetupResult.ok) {
            argoSetupError = argoSetupResult.error
          }
        } catch (e) {
          argoSetupError = e.message
        }
      }      

      // 복사할 원라인 명령어셋 구성 (pure URL 및 올바른 pat 변수 사용)
      const safeProjectName = toK8sName(state.proj)
      const dynamicBootstrapCmd = `export GITHUB_PAT="<YOUR_GITHUB_PAT>" && kubectl create secret generic ${safeProjectName}-git-repo-creds -n argocd --from-literal=type="git" --from-literal=url="${repoUrl}" --from-literal=username="${ghUser.login}" --from-literal=password="$GITHUB_PAT" --dry-run=client -o yaml | kubectl apply --validate=false -f - && kubectl label secret ${safeProjectName}-git-repo-creds -n argocd argocd.argoproj.io/secret-type=repository --overwrite && curl -s -H "Authorization: token $GITHUB_PAT" -L "${rawRepoUrl}/main/k8s/projects/${state.proj}/argo-project.yaml" | kubectl apply --validate=false -n argocd -f - && curl -s -H "Authorization: token $GITHUB_PAT" -L "${rawRepoUrl}/main/k8s/projects/${state.proj}/argo-parent-app.yaml" | kubectl apply --validate=false -n argocd -f - && curl -s -H "Authorization: token $GITHUB_PAT" -L "${rawRepoUrl}/main/k8s/projects/${state.proj}/argo-appset.yaml" | kubectl apply --validate=false -n argocd -f -`;

      setResults({
        repo: `${owner}/${repo}`,
        files: pushResults,
        secrets: secretsResults,
        registry,
        pushOk: true,
        argoSetup: argoSetupResult,
        argoSetupError,
        argoServerUrl: state.argocdServer,
        bootstrapCmd: dynamicBootstrapCmd,
        bootstrap: bootstrapResult,
        bootstrapError,
      })

      // 5. 새 레포면 목록 갱신 + 모드 전환
      if (deployMode === 'create') {
        const updated = await ghListRepos(pat)
        setRepos(updated.map(r => ({
          full_name: r.full_name, name: r.name,
          owner: r.owner.login, private: r.private,
        })))
        set({ selectedRepo: `${owner}/${repo}`, deployMode: 'existing', newRepoName: '' })
      }
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  // 배포 가능 조건
  const repoReady = (deployMode === 'existing' && selectedRepo) ||
    (deployMode === 'create' && newRepoName)
  const registryReady = registry === 'ghcr' || (dockerhubUser && dockerhubToken)
  const canDeploy = !engineResult?.hasError && pat && ghUser && repoReady && registryReady

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      {/* ── 1단계: GitHub 인증 ── */}
      {!ghUser ? (
        <section>
          <SectionHead step="1">GitHub 인증</SectionHead>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
            <Input
              label="GitHub Personal Access Token (Classic)"
              value={pat}
              onChange={v => set({ pat: v })}
              placeholder="ghp_xxxxxxxxxxxx"
              secret
              hint="필요 권한: repo, workflow · 세션 메모리에만 보관 · 새로고침 시 소멸 · Variables/Secrets API는 두 스코프 모두 필요"
            />
            <Btn variant="primary" fullWidth disabled={!pat || busy} onClick={verifyPat}>
              {busy ? '⟳ 확인 중...' : 'PAT 검증 & 레포 목록 가져오기'}
            </Btn>
            <a href="https://github.com/settings/tokens/new?scopes=repo,workflow&description=Grad-Deploy"
              target="_blank" rel="noreferrer"
              style={{ fontSize: 11, color: 'var(--blue)', textDecoration: 'underline', textAlign: 'center' }}>
              GitHub에서 토큰 발급하기 →
            </a>
          </div>
        </section>
      ) : (
        <div style={{
          padding: '12px 14px', borderRadius: 'var(--r2)',
          background: 'rgba(74,222,128,0.06)',
          border: '1px solid rgba(74,222,128,0.25)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          {ghUser.avatar_url && (
            <img src={ghUser.avatar_url} alt="" width={36} height={36}
              style={{ borderRadius: '50%', border: '1px solid var(--border2)' }} />
          )}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{ghUser.name || ghUser.login}</div>
            <div style={{ fontSize: 11, color: 'var(--t3)' }}>@{ghUser.login} · {repos.length} repos</div>
          </div>
          <button onClick={resetPat} style={{
            padding: '4px 10px', fontSize: 11,
            border: '1px solid var(--border2)', borderRadius: 4,
            background: 'transparent', color: 'var(--t2)',
            cursor: 'pointer', fontFamily: 'var(--mono)',
          }}>
            로그아웃
          </button>
        </div>
      )}

      {/* ── 2단계: 컨테이너 레지스트리 선택 ── */}
      {ghUser && (
        <section>
          <SectionHead step="2">컨테이너 레지스트리</SectionHead>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
            <ModeCard
              active={registry === 'ghcr'}
              onClick={() => set({ registry: 'ghcr' })}
              title="GHCR"
              desc="GitHub Container Registry · 추가 설정 불필요"
              icon="◉"
              recommended
            />
            <ModeCard
              active={registry === 'dockerhub'}
              onClick={() => set({ registry: 'dockerhub' })}
              title="Docker Hub"
              desc="hub.docker.com · Access Token 필요"
              icon="◈"
            />
          </div>

          {/* GHCR 안내 */}
          {registry === 'ghcr' && (
            <div style={{
              marginTop: 12, padding: '10px 12px',
              background: 'rgba(96,165,250,0.06)',
              border: '1px solid rgba(96,165,250,0.2)',
              borderRadius: 'var(--r)',
              fontSize: 11, color: 'var(--t2)', lineHeight: 1.7,
            }}>
              <strong style={{ color: 'var(--blue)' }}>✓ GHCR 자동 인증</strong> — CI에서{' '}
              <code style={{ color: 'var(--cyan)' }}>GITHUB_TOKEN</code>으로 자동 로그인되며,
              이미지는 <code style={{ color: 'var(--cyan)' }}>ghcr.io/{ghUser.login.toLowerCase()}/svc</code> 형식으로 푸시됩니다.
            </div>
          )}

          {/* Docker Hub 입력 */}
          {registry === 'dockerhub' && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Input
                label="Docker Hub 사용자명"
                value={dockerhubUser}
                onChange={v => set({ dockerhubUser: v })}
                placeholder="myusername"
              />
              <Input
                label="Docker Hub Access Token"
                value={dockerhubToken}
                onChange={v => set({ dockerhubToken: v })}
                placeholder="dckr_pat_xxxxxxxxxxxx"
                secret
                hint="배포 시 GitHub Secrets에 자동 등록됩니다"
              />
              <a href="https://app.docker.com/settings/personal-access-tokens"
                target="_blank" rel="noreferrer"
                style={{ fontSize: 11, color: 'var(--blue)', textDecoration: 'underline' }}>
                Docker Hub Access Token 발급 →
              </a>
            </div>
          )}
        </section>
      )}

      {/* ── 3단계: 배포 대상 ── */}
      {ghUser && (
        <section>
          <SectionHead step="3">배포 대상</SectionHead>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
            <ModeCard
              active={deployMode === 'existing'}
              onClick={() => set({ deployMode: 'existing' })}
              title="기존 레포에 배포"
              desc={`${repos.length}개의 레포에서 선택`}
              icon="◈"
            />
            <ModeCard
              active={deployMode === 'create'}
              onClick={() => set({ deployMode: 'create' })}
              title="새 레포 생성 후 배포"
              desc="새 GitHub 레포 자동 생성"
              icon="✦"
            />
          </div>

          {deployMode === 'existing' && (
            <div style={{ marginTop: 12 }}>
              <RepoSelector repos={repos} value={selectedRepo} onChange={v => set({ selectedRepo: v })} />
            </div>
          )}

          {deployMode === 'create' && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Input
                label={`새 레포명 (${ghUser.login}/...)`}
                value={newRepoName}
                onChange={v => set({ newRepoName: v.replace(/[^a-zA-Z0-9._-]/g, '') })}
                placeholder="my-grad-deploy-app"
                hint="영문/숫자/하이픈/언더스코어/마침표만 사용"
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <input
                  type="checkbox" checked={newRepoPrivate}
                  onChange={e => set({ newRepoPrivate: e.target.checked })}
                  style={{ accentColor: 'var(--blue)', cursor: 'pointer' }}
                />
                <span style={{ fontSize: 12, color: 'var(--t2)' }}>
                  Private 레포 {newRepoPrivate ? '(권장)' : ''}
                </span>
              </label>
            </div>
          )}
        </section>
      )}

      {/* ── 4단계: Argo CD 자동 연동 (기본 흐름) ── */}
      {ghUser && (selectedRepo || (deployMode === 'create' && newRepoName)) && (
        <section>
          <SectionHead step="4">Argo CD 자동 연동</SectionHead>
          <div style={{
            marginTop: 12, padding: '10px 12px',
            background: 'rgba(96,165,250,0.06)',
            border: '1px solid rgba(96,165,250,0.2)',
            borderRadius: 'var(--r)',
            fontSize: 11, color: 'var(--t2)', lineHeight: 1.7,
          }}>
            <strong style={{ color: 'var(--blue)' }}>✓ 자동화 범위</strong> — 입력 후 배포 시{' '}
            Repository 등록, Application 생성, Sync 시작이 모두 자동으로 처리됩니다.
            <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 4 }}>
              Cloudflare Tunnel(cloudflared) 또는 기타 외부 접근 가능한 URL이 필요합니다.
              입력하지 않으면 파일 push만 수행됩니다.
            </div>
          </div>

          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Input
              label="Argo CD 서버 URL"
              value={state.argocdServer || import.meta.env.VITE_DEFAULT_ARGOCD_SERVER || ''}
              onChange={v => set({ argocdServer: v })}
              placeholder="https://argocd.yourdomain.com"
              hint="Cloudflare Tunnel로 노출한 도메인 (cloudflared tunnel route dns 로 설정)"
            />
            <Input
              label="Argo CD admin 비밀번호"
              value={state.argocdAdminPassword || import.meta.env.VITE_DEFAULT_ARGOCD_PASSWORD || ''}
              onChange={v => set({ argocdAdminPassword: v })}
              placeholder="••••••••"
              secret
              hint="kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"
            />
          </div>
        </section>
      )}

      {/* ── Advanced 모드 토글 ── */}
      {ghUser && (selectedRepo || (deployMode === 'create' && newRepoName)) && (
        <div style={{ marginTop: 8, padding: '12px 14px', background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--r)', border: '1px solid var(--border)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={isAdvancedMode} onChange={e => setIsAdvancedMode(e.target.checked)} style={{ accentColor: 'var(--blue)' }} />
            <span style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 600 }}>고급 설정 활성화 (Advanced Mode)</span>
            <span style={{ fontSize: 11, color: 'var(--t3)' }}>- SSO, RBAC 및 상세 보안 정책 설정</span>
          </label>
        </div>
      )}

      {/* ── 5단계: Argo CD + GitHub SSO 설정 (Advanced) ── */}
      {ghUser && isAdvancedMode && (selectedRepo || (deployMode === 'create' && newRepoName)) && (
        <SsoSetupSection
          pat={pat}
          owner={selectedRepo ? selectedRepo.split('/')[0] : ghUser.login}
          repo={selectedRepo ? selectedRepo.split('/')[1] : newRepoName}
          state={state}
          set={set}
        />
      )}

      {/* ── 가드레일 경고 ── */}
      {engineResult?.hasError && (
        <div style={{
          background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)',
          borderRadius: 'var(--r)', padding: '10px 14px', fontSize: 12, color: 'var(--red)',
        }}>
          ✕ ERROR 수준 가드레일 위반이 있습니다. 가드레일 탭에서 해결 후 배포하세요.
        </div>
      )}

      {/* ── 에러 ── */}
      {error && (
        <div style={{
          background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.35)',
          borderRadius: 'var(--r)', padding: '10px 14px', fontSize: 12, color: 'var(--red)',
        }}>
          ✕ {error}
        </div>
      )}

      {/* ── 배포 버튼 ── */}
      {ghUser && (
        <Btn variant="primary" fullWidth disabled={!canDeploy || busy} onClick={handleDeploy} size="lg">
          {busy
            ? '⟳ 배포 중...'
            : engineResult?.hasError
              ? '가드레일 오류 해결 필요'
              : !registryReady
                ? 'Docker Hub 정보 입력 필요'
                : !repoReady
                  ? '레포 선택 필요'
                  : deployMode === 'create'
                    ? `🚀 새 레포 생성 & 배포 (${registry === 'ghcr' ? 'GHCR' : 'Docker Hub'})`
                    : `🚀 ${selectedRepo}에 배포`}
        </Btn>
      )}

      {/* ── 결과 ── */}
      {results && (
        <section>
          <SectionHead>배포 결과</SectionHead>
          <div style={{
            marginTop: 10, padding: '10px 12px', borderRadius: 'var(--r)',
            background: results.pushOk === false ? 'rgba(248,113,113,0.06)' : 'rgba(74,222,128,0.07)',
            border: `1px solid ${results.pushOk === false ? 'rgba(248,113,113,0.3)' : 'rgba(74,222,128,0.25)'}`,
          }}>
            <div style={{
              fontSize: 12,
              color: results.pushOk === false ? 'var(--red)' : 'var(--green)',
              fontWeight: 600,
              marginBottom: 6,
            }}>
              {results.pushOk === false ? '✕ Push 실패' : '✓ Push 완료'} → {results.repo}
            </div>
            {results.pushOk === false && results.argoSetupError && (
              <div style={{ fontSize: 11, color: 'var(--red)', marginBottom: 8, lineHeight: 1.5 }}>
                {results.argoSetupError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 12, fontSize: 11 }}>
              <a href={`https://github.com/${results.repo}`} target="_blank" rel="noreferrer"
                style={{ color: 'var(--blue)', textDecoration: 'underline' }}>
                GitHub →
              </a>
              <a href={`https://github.com/${results.repo}/actions`} target="_blank" rel="noreferrer"
                style={{ color: 'var(--blue)', textDecoration: 'underline' }}>
                Actions 보기 →
              </a>
            </div>
          </div>

          {/* Secrets 등록 결과 */}
          {results.secrets && results.secrets.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, color: 'var(--t3)', marginBottom: 4, letterSpacing: '0.06em' }}>SECRETS 등록</div>
              {results.secrets.map(s => (
                <div key={s.name} style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: 11, padding: '5px 9px', borderRadius: 4,
                  background: s.ok ? 'rgba(74,222,128,0.05)' : 'rgba(248,113,113,0.06)',
                }}>
                  <span style={{ color: 'var(--t2)', fontFamily: 'var(--mono)' }}>{s.name}</span>
                  <span style={{ color: s.ok ? 'var(--green)' : 'var(--red)' }}>
                    {s.ok ? '✓ 등록됨' : `✕ ${s.error}`}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* 파일 push 결과 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 8 }}>
            <div style={{ fontSize: 10, color: 'var(--t3)', marginBottom: 2, letterSpacing: '0.06em' }}>파일 PUSH</div>
            {results.files.map(r => (
              <div key={r.path} style={{
                display: 'flex', flexDirection: 'column', gap: 2,
                fontSize: 11, padding: '5px 9px', borderRadius: 4,
                background: r.ok ? 'rgba(74,222,128,0.05)' : 'rgba(248,113,113,0.06)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--t2)', fontFamily: 'var(--mono)' }}>{r.path}</span>
                  <span style={{ color: r.ok ? 'var(--green)' : 'var(--red)' }}>
                    {r.ok ? `✓ ${r.status}` : `✕ ${r.error || r.status}`}
                  </span>
                </div>
                {/* 실패 시 GitHub API 에러 메시지를 추가로 표시 (진단 용이성) */}
                {!r.ok && r.message && (
                  <div style={{
                    fontSize: 10, color: 'var(--red)', opacity: 0.85,
                    fontFamily: 'var(--mono)', marginTop: 2, paddingLeft: 2,
                  }}>
                    └ {r.message}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* ArgoCD 자동 연동 결과 */}
          {results.bootstrap && (
            <div style={{
              marginTop: 12,
              padding: '10px 14px',
              borderRadius: 'var(--r)',
              background: results.bootstrap.ok ? 'rgba(74,222,128,0.05)' : 'rgba(248,113,113,0.06)',
              border: `1px solid ${results.bootstrap.ok ? 'rgba(74,222,128,0.25)' : 'rgba(248,113,113,0.3)'}`,
              fontSize: 11,
              color: results.bootstrap.ok ? 'var(--green)' : 'var(--red)',
              lineHeight: 1.6,
            }}>
              {results.bootstrap.ok ? '✓ Argo CD bootstrap 완료' : `✕ Argo CD bootstrap 실패: ${results.bootstrapError || results.bootstrap.error || 'unknown'}`}
            </div>
          )}

          {/* ArgoCD 자동 연동 결과 */}
          {results.argoSetup && (
            <div style={{
              marginTop: 16,
              padding: 14,
              background: results.argoSetup.ok
                ? 'rgba(74,222,128,0.07)'
                : 'rgba(248,113,113,0.06)',
              borderRadius: 'var(--r2)',
              border: `1px solid ${results.argoSetup.ok
                ? 'rgba(74,222,128,0.3)'
                : 'rgba(248,113,113,0.3)'}`,
            }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                marginBottom: 10,
              }}>
                <span style={{
                  fontSize: 13, fontWeight: 600,
                  color: results.argoSetup.ok ? 'var(--green)' : 'var(--red)',
                }}>
                  {results.argoSetup.ok
                    ? '🚀 Argo CD 자동 연동 완료'
                    : '⚠ Argo CD 자동 연동 일부 실패'}
                </span>
                {results.argoServerUrl && (
                  <a
                    href={results.argoServerUrl}
                    target="_blank" rel="noreferrer"
                    style={{ fontSize: 11, color: 'var(--blue)', textDecoration: 'underline' }}
                  >
                    Argo CD 열기 →
                  </a>
                )}
              </div>

              {/* 단계별 결과 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {results.argoSetup.steps.map((s, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8,
                    padding: '6px 10px', borderRadius: 4,
                    background: s.ok
                      ? 'rgba(74,222,128,0.05)'
                      : 'rgba(248,113,113,0.06)',
                  }}>
                    <span style={{
                      fontSize: 11,
                      color: s.ok ? 'var(--green)' : 'var(--red)',
                      flexShrink: 0,
                    }}>
                      {s.ok ? '✓' : '✕'}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: 'var(--t1)', fontWeight: 600 }}>
                        {s.name}
                      </div>
                      {s.detail && (
                        <div style={{
                          fontSize: 10, color: 'var(--t3)', marginTop: 2,
                          fontFamily: 'var(--mono)', wordBreak: 'break-all',
                        }}>
                          {s.detail}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {results.argoSetup.ok && (
                <div style={{
                  marginTop: 10, fontSize: 11, color: 'var(--t2)', lineHeight: 1.6,
                }}>
                  ✓ <strong style={{ color: 'var(--green)' }}>완료</strong>: Repository 등록 + Application 생성 + Sync 시작.
                  이후 코드를 push하면 webhook(또는 polling)을 통해 자동으로 동기화됩니다.
                </div>
              )}
            </div>
          )}

          {results.argoSetupError && !results.argoSetup && (
            <div style={{
              marginTop: 12, padding: '10px 14px', borderRadius: 'var(--r)',
              background: 'rgba(248,113,113,0.06)',
              border: '1px solid rgba(248,113,113,0.3)',
              fontSize: 11, color: 'var(--red)', lineHeight: 1.6,
            }}>
              ✕ Argo CD 자동 연동 실패: {results.argoSetupError}
              <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 4 }}>
                {results.pushOk === false
                  ? '파일 Push가 실패하여 Argo CD 자동 연동을 중단했습니다. GitHub PAT 권한을 확인한 뒤 다시 배포하세요.'
                  : '파일 Push는 완료되었습니다. Argo CD UI에서 수동으로 Application을 생성해 주세요.'}
              </div>
            </div>
          )}

          {/* ── 부트스트랩 명령어 (PAT 자동 연동) ──────────────── */}
          {results.bootstrapCmd && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 10, color: 'var(--t3)', marginBottom: 8, letterSpacing: '0.06em', fontWeight: 600 }}>
                BOOTSTRAP 명령어 (GitHub PAT 자동 연동)
              </div>
              <div style={{
                padding: '14px', background: 'rgba(0,0,0,0.3)', borderRadius: 'var(--r2)',
                border: '1px solid var(--border)', position: 'relative',
                boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.2)'
              }}>
                <pre style={{
                  fontSize: 11, color: 'var(--cyan)', whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all', margin: 0, fontFamily: 'var(--mono)',
                  lineHeight: 1.5
                }}>
                  {results.bootstrapCmd}
                </pre>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(results.bootstrapCmd)
                    alert('보안 자격 증명이 포함된 명령어가 복사되었습니다!')
                  }}
                  style={{
                    position: 'absolute', top: 10, right: 10,
                    padding: '5px 10px', fontSize: 10, fontWeight: 700,
                    background: 'var(--blue)', color: '#0b0f1c',
                    border: 'none', borderRadius: 4, cursor: 'pointer',
                    transition: 'transform 0.1s',
                  }}
                  onMouseDown={e => e.currentTarget.style.transform = 'scale(0.95)'}
                  onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}
                >
                  COPY
                </button>
              </div>
              <div style={{
                marginTop: 8, padding: '8px 12px', borderRadius: 6,
                background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.15)',
                fontSize: 10, color: 'var(--t3)', display: 'flex', gap: 8, alignItems: 'center'
              }}>
                <span style={{ color: 'var(--blue)', fontWeight: 800 }}>TIP</span>
                <span>위 명령어를 복사하여 K8s 터미널에 붙여넣으세요. Argo CD가 Private 레포를 즉시 인식합니다.</span>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── 6단계: 플랫폼 정책 경고 ── */}
      <section>
        <SectionHead step="6">플랫폼 보호 정책 확인</SectionHead>
        <div style={{
          padding: '12px 14px', borderRadius: 'var(--r2)',
          background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.25)',
          fontSize: 11, color: 'var(--amber)', lineHeight: 1.7, marginTop: 12
        }}>
          <strong style={{ color: 'var(--amber)', display: 'block', marginBottom: 4 }}>⚠ 다음 K8s 리소스는 플랫폼에 의해 수정이 차단됩니다 (AppProject Blacklist):</strong>
          • ResourceQuota, LimitRange<br />
          (해당 리소스를 사용자가 직접 수정 시 Argo CD가 배포를 차단합니다. <strong>이 설정은 플랫폼 팀에 의해 보호됨.</strong> 변경이 필요하면 플랫폼 팀에 문의하세요.)
        </div>
      </section>

      {/* ── FSM ── */}
      <section>
        <SectionHead>배포 상태 흐름 (FSM)</SectionHead>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
          {FSM.map((st, i) => (
            <div key={st.q} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{
                padding: '4px 10px', borderRadius: 4,
                background: `${st.color}15`, border: `1px solid ${st.color}35`,
                color: st.color, fontSize: 11, fontWeight: 600,
              }}>{st.label}</div>
              {i < FSM.length - 1 && <span style={{ color: 'var(--t3)', fontSize: 10 }}>→</span>}
            </div>
          ))}
        </div>
        <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 8 }}>
          q5: DriftDetected → reconcile / accept_drift / rollback / manual_fix
        </div>
      </section>
    </div>
  )
}

// ── 헬퍼 컴포넌트 ────────────────────────────────────────

function SectionHead({ children, step }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      paddingBottom: 8, borderBottom: '1px solid var(--border2)',
    }}>
      {step && (
        <span style={{
          width: 18, height: 18, borderRadius: '50%',
          background: 'var(--blue)', color: '#0b0f1c',
          fontSize: 10, fontWeight: 800,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{step}</span>
      )}
      <span style={{
        fontSize: 11, fontWeight: 700, color: 'var(--blue)',
        letterSpacing: '0.12em', textTransform: 'uppercase',
      }}>{children}</span>
    </div>
  )
}

function ModeCard({ active, onClick, title, desc, icon, recommended }) {
  return (
    <button onClick={onClick} style={{
      padding: '12px', borderRadius: 'var(--r2)', cursor: 'pointer',
      border: `1px solid ${active ? 'var(--blue)' : 'var(--border2)'}`,
      background: active ? 'rgba(96,165,250,0.12)' : 'rgba(255,255,255,0.02)',
      textAlign: 'left', fontFamily: 'var(--mono)',
      transition: 'all .15s',
      display: 'flex', flexDirection: 'column', gap: 4,
      position: 'relative',
    }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.borderColor = 'rgba(96,165,250,0.5)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.borderColor = 'var(--border2)' }}
    >
      {recommended && (
        <span style={{
          position: 'absolute', top: 6, right: 8,
          fontSize: 8, fontWeight: 700,
          color: 'var(--green)', letterSpacing: '0.05em',
          background: 'rgba(74,222,128,0.12)',
          padding: '1px 5px', borderRadius: 3,
        }}>
          권장
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 14, color: active ? 'var(--blue)' : 'var(--t2)' }}>{icon}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: active ? 'var(--blue)' : 'var(--t1)' }}>
          {title}
        </span>
      </div>
      <span style={{ fontSize: 10, color: 'var(--t3)', paddingLeft: 20, lineHeight: 1.5 }}>{desc}</span>
    </button>
  )
}

// ════════ SsoSetupSection ════════════════════════════════
// [역할2] GitHub SSO + Argo CD 통합 설정 섹션
//
// 탭 구조:
//   Tab A — Argo CD 연동: 서버 URL + 토큰 등록 (기존 ArgoSetupSection 기능 유지)
//   Tab B — GitHub SSO:   Org/팀 입력 → dex 설정 + RBAC 정책 자동 반영
//
// 상태 흐름:
//   사용자 입력 → set()으로 state 저장 → buildAllFiles 호출 시 k8s_improved 로 전달
//   → genArgoCDAdminConfig({ ssoTeams, githubOrg, githubClientId, argocdServer })
//   → k8s/argocd-admin/argocd-cm.yaml / argocd-rbac-cm.yaml / setup.sh 생성
//
// 역할 선택 옵션:
//   admin    — argocd-cm, rbac-cm 포함 전체 관리 (argocd-admins 팀 전용)
//   deploy   — CI 파이프라인 전용 (sync/get/update, ARGOCD_TOKEN 으로 사용)
//   readonly — 조회 전용 (기본값, 명시 지정 불필요한 팀에 적합)
function SsoSetupSection({ pat, owner, repo, state, set }) {
  // ── Tab A: Argo CD 연동 ──────────────────────────────
  const [activeTab, setActiveTab] = useState('argo')   // 'argo' | 'sso'
  const [inputMode, setInputMode] = useState('token')  // 'token' | 'creds'
  const [argoUser, setArgoUser] = useState('admin')
  const [argoPass, setArgoPass] = useState('')
  const [argoToken, setArgoToken] = useState('')
  const [busyArgo, setBusyArgo] = useState(false)
  const [errorArgo, setErrorArgo] = useState(null)
  const [argoResults, setArgoResults] = useState(null)
  const [webhookResult, setWebhookResult] = useState(null)

  // ── Tab B: GitHub SSO ────────────────────────────────
  // state 에서 읽어 set() 으로 저장 → buildAllFiles 에 그대로 전달됨
  const ssoClientId = state.ssoClientId || ''
  const ssoClientSecret = state.ssoClientSecret || '' // 화면 표시용 — GitHub Secret 으로만 전달, 절대 push 안 됨
  const argocdServer = state.argocdServer || ''
  const ssoTeams = state.ssoTeams || []    // [{ team, role }]

  // 팀 추가/삭제 헬퍼
  const addTeam = () => set({ ssoTeams: [...ssoTeams, { team: '', role: 'deploy', proj: '', ns: '' }] })
  const updTeam = (i, patch) => set({
    ssoTeams: ssoTeams.map((t, idx) => idx === i ? { ...t, ...patch } : t)
  })
  const delTeam = i => set({ ssoTeams: ssoTeams.filter((_, idx) => idx !== i) })

  // ── Tab A 핸들러 ─────────────────────────────────────
  const serverTrimmed = argocdServer.trim().replace(/\/$/, '')
  const serverHost = serverTrimmed.replace(/^https?:\/\//, '')
  const repoValid = !!(owner && repo)  // owner/repo 모두 있어야 API 호출 가능
  const canSetupArgo = repoValid && serverHost && (inputMode === 'token' ? argoToken.trim() : (argoUser && argoPass))
  const argoAllOk = argoResults?.every(r => r.ok)
  const webhookOk = webhookResult?.ok === true

  const handleArgoSetup = async () => {
    setBusyArgo(true); setErrorArgo(null); setArgoResults(null)
    try {
      if (!serverTrimmed) throw new Error('Argo CD 서버 URL을 입력하세요')
      let finalToken = argoToken.trim()
      if (inputMode === 'creds') {
        finalToken = await argoFetchToken(serverTrimmed, argoUser, argoPass)
      }
      if (!finalToken) throw new Error('토큰이 비어 있습니다')

      const r = []
      try {
        await ghSetVariable(pat, owner, repo, 'ARGOCD_SERVER', serverHost)
        r.push({ name: 'ARGOCD_SERVER', type: 'Variable', ok: true })
      } catch (e) { r.push({ name: 'ARGOCD_SERVER', type: 'Variable', ok: false, error: e.message }) }
      try {
        await ghSetSecret(pat, owner, repo, 'ARGOCD_TOKEN', finalToken)
        r.push({ name: 'ARGOCD_TOKEN', type: 'Secret', ok: true })
      } catch (e) { r.push({ name: 'ARGOCD_TOKEN', type: 'Secret', ok: false, error: e.message }) }

      setArgoResults(r)
      if (r.some(x => x.ok)) {
        try {
          const wh = await ghRegisterWebhook(pat, owner, repo, serverHost)
          setWebhookResult({ ok: true, ...wh })
        } catch (e) { setWebhookResult({ ok: false, error: e.message }) }
      }
    } catch (e) { setErrorArgo(e.message) }
    finally { setBusyArgo(false) }
  }

  // ── Tab B 핸들러 ─────────────────────────────────────
  const [busySso, setBusySso] = useState(false)
  const [errorSso, setErrorSso] = useState(null)
  const [ssoResults, setSsoResults] = useState(null)

  // SSO 설정을 GitHub Secrets/Variables 에 등록
  // ARGOCD_GITHUB_CLIENT_ID → Repository Variable (공개 가능)
  // (Client Secret 은 setup.sh 로만 주입, 브라우저에서 직접 등록 금지)
  const canSetupSso = repoValid && ssoClientId.trim() && argocdServer.trim()

  const handleSsoSetup = async () => {
    setBusySso(true); setErrorSso(null); setSsoResults(null)
    try {
      const r = []
      // Client ID → GitHub Repository Variable (평문 저장 가능)
      try {
        await ghSetVariable(pat, owner, repo, 'ARGOCD_GITHUB_CLIENT_ID', ssoClientId.trim())
        r.push({
          name: 'ARGOCD_GITHUB_CLIENT_ID', type: 'Variable', ok: true,
          note: 'argocd-cm의 clientID 참조값으로 사용됩니다'
        })
      } catch (e) {
        r.push({ name: 'ARGOCD_GITHUB_CLIENT_ID', type: 'Variable', ok: false, error: e.message })
      }
      // Argo CD 서버 URL → Variable (argocd-cm redirectURI 생성에 사용)
      if (serverHost) {
        try {
          await ghSetVariable(pat, owner, repo, 'ARGOCD_SERVER', serverHost)
          r.push({ name: 'ARGOCD_SERVER', type: 'Variable', ok: true })
        } catch (e) {
          r.push({ name: 'ARGOCD_SERVER', type: 'Variable', ok: false, error: e.message })
        }
      }
      setSsoResults(r)
    } catch (e) { setErrorSso(e.message) }
    finally { setBusySso(false) }
  }

  const ssoAllOk = ssoResults?.every(r => r.ok)

  // 역할 선택 옵션
  const ROLE_OPTIONS = [
    { value: 'admin', label: 'Admin — 전체 관리', color: 'var(--red)' },
    { value: 'deploy', label: 'Deploy — CI 전용', color: 'var(--blue)' },
    { value: 'readonly', label: 'Readonly — 조회만', color: 'var(--t3)' },
  ]

  return (
    <section>
      <SectionHead step="5">Argo CD + GitHub SSO (Advanced)</SectionHead>

      {/* 탭 */}
      <div style={{ display: 'flex', gap: 4, marginTop: 12, marginBottom: 14 }}>
        {[
          { key: 'argo', label: 'Argo CD 연동', icon: '◈' },
          { key: 'sso', label: 'GitHub SSO', icon: '◉' },
        ].map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)} style={{
            padding: '6px 14px', borderRadius: 'var(--r)', fontSize: 11,
            fontWeight: activeTab === t.key ? 700 : 400,
            border: `1px solid ${activeTab === t.key ? 'var(--blue)' : 'var(--border2)'}`,
            background: activeTab === t.key ? 'rgba(96,165,250,0.12)' : 'transparent',
            color: activeTab === t.key ? 'var(--blue)' : 'var(--t2)',
            cursor: 'pointer', fontFamily: 'var(--mono)',
          }}>
            <span style={{ marginRight: 5, opacity: 0.7 }}>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      {/* ══ Tab A: Argo CD 연동 ═══════════════════════════ */}
      {activeTab === 'argo' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.7 }}>
            <code style={{ color: 'var(--cyan)', fontSize: 10 }}>ARGOCD_SERVER</code> (Variable)와{' '}
            <code style={{ color: 'var(--cyan)', fontSize: 10 }}>ARGOCD_TOKEN</code> (Secret)을
            GitHub에 자동 등록합니다. 토큰은 <strong style={{ color: 'var(--amber)' }}>admin 계정 대신
              deploy-role 전용 토큰</strong>을 사용하세요.
          </div>

          {/* 서버 URL — state 에 저장해 SSO 탭과 공유 */}
          <Input
            label="Argo CD 서버 URL"
            value={argocdServer}
            onChange={v => set({ argocdServer: v })}
            placeholder="https://argocd.example.com"
            hint="SSO 탭의 redirectURI / Webhook URL 에도 사용됩니다"
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <ModeCard active={inputMode === 'token'} onClick={() => setInputMode('token')}
              title="토큰 직접 입력" desc="deploy-role 전용 토큰 붙여넣기" icon="◈" recommended />
            <ModeCard active={inputMode === 'creds'} onClick={() => setInputMode('creds')}
              title="계정으로 발급" desc="admin 계정으로 세션 토큰 획득" icon="◉" />
          </div>

          {inputMode === 'token' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Input label="Argo CD API 토큰" value={argoToken}
                onChange={v => setArgoToken(v)} placeholder="eyJhbGciOiJS..." secret
                hint="deploy-role 토큰 권장: argocd account generate-token --account {proj}-deploy" />
              {/* deploy-role 토큰 발급 안내 */}
              <div style={{
                padding: '8px 12px', borderRadius: 'var(--r)',
                background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.2)',
                fontSize: 10, color: 'var(--t2)', lineHeight: 1.7,
              }}>
                <strong style={{ color: 'var(--blue)' }}>deploy-role 토큰 발급 방법</strong><br />
                <code style={{ color: 'var(--cyan)' }}>argocd account generate-token --account {owner}-deploy</code><br />
                <span style={{ color: 'var(--t3)' }}>
                  admin 토큰은 초기 1회 설정 후 사용하지 마세요. (최소 권한 원칙)
                </span>
                {serverTrimmed && (
                  <a href={`${serverTrimmed}/settings/accounts/admin`} target="_blank" rel="noreferrer"
                    style={{ display: 'block', marginTop: 4, color: 'var(--blue)', textDecoration: 'underline' }}>
                    Argo CD 계정 설정 →
                  </a>
                )}
              </div>
            </div>
          )}

          {inputMode === 'creds' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{
                padding: '8px 12px', borderRadius: 'var(--r)',
                background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)',
                fontSize: 10, color: 'var(--amber)', lineHeight: 1.6,
              }}>
                ⚠ CORS 설정에 따라 브라우저 직접 연결이 제한될 수 있습니다.
                실패 시 "토큰 직접 입력" 모드를 사용하세요.
              </div>
              <Input label="사용자명" value={argoUser} onChange={v => setArgoUser(v)} placeholder="admin" />
              <Input label="비밀번호" value={argoPass} onChange={v => setArgoPass(v)} placeholder="••••••••" secret />
            </div>
          )}

          {errorArgo && (
            <div style={{
              background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)',
              borderRadius: 'var(--r)', padding: '10px 14px', fontSize: 11, color: 'var(--red)'
            }}>
              ✕ {errorArgo}
            </div>
          )}

          {argoResults && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {argoResults.map(r => (
                <div key={r.name} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  fontSize: 11, padding: '5px 9px', borderRadius: 4,
                  background: r.ok ? 'rgba(74,222,128,0.05)' : 'rgba(248,113,113,0.06)',
                }}>
                  <span style={{ color: 'var(--t2)', fontFamily: 'var(--mono)' }}>
                    {r.name}
                    <span style={{ color: 'var(--t3)', fontSize: 9, marginLeft: 4 }}>[{r.type}]</span>
                  </span>
                  <span style={{ color: r.ok ? 'var(--green)' : 'var(--red)' }}>
                    {r.ok ? '✓ 등록됨' : `✕ ${r.error}`}
                  </span>
                </div>
              ))}
              {argoAllOk && webhookOk && (
                <div style={{
                  padding: '12px 14px', borderRadius: 'var(--r2)',
                  background: 'linear-gradient(135deg, rgba(34,233,160,0.08), rgba(82,156,255,0.08))',
                  border: '1px solid rgba(34,233,160,0.3)', fontSize: 11, lineHeight: 1.7,
                }}>
                  <div style={{ fontWeight: 700, color: 'var(--green)', marginBottom: 6 }}>✓ US-03 인수 조건 충족</div>
                  <div style={{ color: 'var(--t2)' }}>
                    · GitHub Push → Webhook → Argo CD Sync <strong style={{ color: 'var(--green)' }}>즉시(&lt;30초)</strong> 시작<br />
                    · Self-healing: <code style={{ color: 'var(--cyan)', fontSize: 10 }}>selfHeal: true</code> 적용 중
                  </div>
                </div>
              )}
              {argoAllOk && webhookResult === null && (
                <div style={{
                  padding: '8px 12px', borderRadius: 'var(--r)',
                  background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)',
                  fontSize: 10, color: 'var(--amber)', lineHeight: 1.6
                }}>
                  ⚠ Webhook 미등록 — Git 폴링 3분 간격. Webhook 등록 시 즉시 Sync(US-03).
                </div>
              )}
              {webhookResult && !webhookResult.ok && (
                <div style={{
                  padding: '8px 12px', borderRadius: 'var(--r)',
                  background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.25)',
                  fontSize: 11, color: 'var(--red)'
                }}>
                  ✕ Webhook 등록 실패: {webhookResult.error}
                </div>
              )}
            </div>
          )}

          <Btn variant="primary" fullWidth disabled={!canSetupArgo || busyArgo || !!argoAllOk}
            onClick={handleArgoSetup}>
            {busyArgo ? '⟳ 설정 중...'
              : argoAllOk ? '✓ 등록 완료'
                : !repoValid ? '배포 대상 레포를 먼저 선택하세요'
                  : 'GitHub에 Argo CD 설정 자동 등록'}
          </Btn>
        </div>
      )}

      {/* ══ Tab B: GitHub SSO ════════════════════════════ */}
      {activeTab === 'sso' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* SSO 개요 안내 */}
          <div style={{
            padding: '10px 14px', borderRadius: 'var(--r)',
            background: 'rgba(96,165,250,0.05)', border: '1px solid rgba(96,165,250,0.2)',
            fontSize: 11, color: 'var(--t2)', lineHeight: 1.7,
          }}>
            <strong style={{ color: 'var(--blue)' }}>GitHub SSO 설정 흐름</strong><br />
            ① GitHub OAuth App 생성 → ② 아래 정보 입력 → ③ "GitHub에 등록" 클릭<br />
            → ④ 배포 버튼 클릭 시 <code style={{ color: 'var(--cyan)', fontSize: 10 }}>k8s/argocd-admin/</code> 에 YAML + <code style={{ color: 'var(--cyan)', fontSize: 10 }}>setup.sh</code> 자동 생성<br />
            → ⑤ <code style={{ color: 'var(--amber)', fontSize: 10 }}>bash setup.sh</code> 실행으로 Client Secret 주입 + argocd 재시작
          </div>

          {/* GitHub OAuth App 생성 안내 */}
          <div style={{
            padding: '10px 14px', borderRadius: 'var(--r)',
            background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)',
            fontSize: 11, color: 'var(--t3)', lineHeight: 1.7,
          }}>
            <strong style={{ color: 'var(--t2)' }}>GitHub OAuth App 생성 방법</strong><br />
            GitHub → Settings → Developer settings → OAuth Apps → New OAuth App<br />
            · Homepage URL: <code style={{ color: 'var(--cyan)', fontSize: 10 }}>{argocdServer || 'https://argocd.example.com'}</code><br />
            · Callback URL: <code style={{ color: 'var(--cyan)', fontSize: 10 }}>{argocdServer || 'https://argocd.example.com'}/api/dex/callback</code>
            {argocdServer && (
              <a href="https://github.com/settings/applications/new" target="_blank" rel="noreferrer"
                style={{ display: 'block', marginTop: 4, color: 'var(--blue)', textDecoration: 'underline' }}>
                GitHub OAuth App 생성하기 →
              </a>
            )}
          </div>

          {/* GitHub OAuth App Client ID */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
            <Input label="OAuth App Client ID"
              value={ssoClientId}
              onChange={v => set({ ssoClientId: v })}
              placeholder="Ov23liXXXXXXXXXX"
              hint="OAuth App 생성 후 표시되는 Client ID" />
          </div>

          {/* Client Secret 안내 — Git 저장 금지, setup.sh 로만 주입 */}
          <div style={{
            padding: '10px 14px', borderRadius: 'var(--r)',
            background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.2)',
            fontSize: 11, lineHeight: 1.7,
          }}>
            <strong style={{ color: 'var(--red)' }}>⚠ Client Secret 처리 방법 (플로우 필수 단계)</strong>
            <div style={{ color: 'var(--t2)', marginTop: 4 }}>
              Client Secret은 Git에 저장할 수 없습니다. <strong>배포 후 반드시</strong>{' '}
              <code style={{ color: 'var(--amber)', fontSize: 10 }}>k8s/argocd-admin/setup.sh</code>를
              실행해 직접 주입하세요. (미수행 시 모든 SSO 로그인이 즉시 실패합니다.)
            </div>
            <div style={{
              marginTop: 6, fontFamily: 'var(--mono)', fontSize: 10,
              color: 'var(--green)', background: 'rgba(0,0,0,0.3)', padding: '6px 10px', borderRadius: 4
            }}>
              export ARGOCD_CLIENT_SECRET="your-secret-here"<br />
              bash k8s/argocd-admin/setup.sh
            </div>
          </div>

          {/* 유저별 역할 매핑 */}
          <div>
            <div style={{
              fontSize: 10, fontWeight: 700, color: 'var(--blue)',
              letterSpacing: '0.1em', textTransform: 'uppercase',
              marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid var(--border)',
            }}>
              유저별 역할 매핑 (RBAC 정책 자동 생성)
            </div>

            {/* 역할 계층 안내 */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
              {ROLE_OPTIONS.map(r => (
                <span key={r.value} style={{
                  fontSize: 10, padding: '3px 9px', borderRadius: 4,
                  background: `${r.color}12`, border: `1px solid ${r.color}30`, color: r.color,
                  fontFamily: 'var(--mono)',
                }}>
                  {r.label}
                </span>
              ))}
            </div>

            {/* 동적 사용자 목록 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {ssoTeams.map((t, i) => (
                <div key={i} style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto auto',
                  gap: 8, alignItems: 'center',
                  padding: '7px 10px', borderRadius: 'var(--r)',
                  background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)',
                }}>
                  <input
                    value={t.team || ''}
                    onChange={e => updTeam(i, { team: e.target.value })}
                    placeholder="GitHub 유저명 (예: leesean2)"
                    style={{
                      background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border2)',
                      borderRadius: 'var(--r)', color: 'var(--t1)', padding: '5px 9px',
                      fontSize: 11, fontFamily: 'var(--mono)', outline: 'none',
                    }}
                  />
                  <input
                    value={t.proj || ''}
                    onChange={e => updTeam(i, { proj: e.target.value })}
                    placeholder="프로젝트명"
                    style={{
                      background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border2)',
                      borderRadius: 'var(--r)', color: 'var(--t1)', padding: '5px 9px',
                      fontSize: 11, fontFamily: 'var(--mono)', outline: 'none',
                    }}
                  />
                  <input
                    value={t.ns || ''}
                    onChange={e => updTeam(i, { ns: e.target.value })}
                    placeholder="Namespace"
                    style={{
                      background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border2)',
                      borderRadius: 'var(--r)', color: 'var(--t1)', padding: '5px 9px',
                      fontSize: 11, fontFamily: 'var(--mono)', outline: 'none',
                    }}
                  />
                  <select
                    value={t.role || 'readonly'}
                    onChange={e => updTeam(i, { role: e.target.value })}
                    style={{
                      background: 'var(--bg3)', border: '1px solid var(--border2)',
                      borderRadius: 'var(--r)', color: 'var(--t1)', padding: '5px 9px',
                      fontSize: 11, fontFamily: 'var(--mono)', outline: 'none', cursor: 'pointer',
                    }}
                  >
                    <option value="deploy">Deploy</option>
                    <option value="readonly">Readonly</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button onClick={() => delTeam(i)} style={{
                    background: 'none', border: 'none', color: 'var(--t3)',
                    cursor: 'pointer', fontSize: 16, padding: '2px 6px', borderRadius: 4,
                  }}
                    onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
                    onMouseLeave={e => e.currentTarget.style.color = 'var(--t3)'}
                  >×</button>
                </div>
              ))}
            </div>

            <button onClick={addTeam} style={{
              marginTop: 8, width: '100%', padding: '7px', borderRadius: 'var(--r)',
              border: '1px dashed var(--border2)', background: 'transparent',
              color: 'var(--t3)', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--mono)',
              transition: 'all .15s',
            }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--blue)'; e.currentTarget.style.borderColor = 'var(--blue)' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--t3)'; e.currentTarget.style.borderColor = 'var(--border2)' }}
            >
              + 팀 추가
            </button>
          </div>

          {/* 생성될 파일 미리보기 */}
          {(ssoClientId || ssoTeams.length > 0) && (
            <div style={{
              padding: '10px 14px', borderRadius: 'var(--r)',
              background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)',
              fontSize: 10, color: 'var(--t3)', lineHeight: 1.8, fontFamily: 'var(--mono)',
            }}>
              <div style={{ color: 'var(--blue)', fontWeight: 700, marginBottom: 4 }}>
                배포 시 자동 생성되는 파일
              </div>
              <div>k8s/argocd-admin/argocd-cm.yaml
                <span style={{ color: 'var(--t3)', marginLeft: 8 }}>← dex 설정</span>
              </div>
              <div>k8s/argocd-admin/argocd-rbac-cm.yaml
                <span style={{ color: 'var(--t3)', marginLeft: 8 }}>← RBAC 3계층 정책</span>
              </div>
              <div>k8s/argocd-admin/setup.sh
                <span style={{ color: 'var(--amber)', marginLeft: 8 }}>← Client Secret 주입 스크립트</span>
              </div>
            </div>
          )}

          {errorSso && (
            <div style={{
              background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)',
              borderRadius: 'var(--r)', padding: '10px 14px', fontSize: 11, color: 'var(--red)'
            }}>
              ✕ {errorSso}
            </div>
          )}

          {ssoResults && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {ssoResults.map(r => (
                <div key={r.name} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  fontSize: 11, padding: '5px 9px', borderRadius: 4,
                  background: r.ok ? 'rgba(74,222,128,0.05)' : 'rgba(248,113,113,0.06)',
                }}>
                  <div>
                    <span style={{ color: 'var(--t2)', fontFamily: 'var(--mono)' }}>{r.name}</span>
                    <span style={{ color: 'var(--t3)', fontSize: 9, marginLeft: 4 }}>[{r.type}]</span>
                    {r.note && <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 2 }}>{r.note}</div>}
                  </div>
                  <span style={{ color: r.ok ? 'var(--green)' : 'var(--red)', flexShrink: 0 }}>
                    {r.ok ? '✓ 등록됨' : `✕ ${r.error}`}
                  </span>
                </div>
              ))}
              {ssoAllOk && (
                <div style={{
                  padding: '10px 14px', borderRadius: 'var(--r)',
                  background: 'rgba(74,222,128,0.07)', border: '1px solid rgba(74,222,128,0.25)',
                  fontSize: 11, color: 'var(--green)', lineHeight: 1.7,
                }}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>✓ GitHub Variable 등록 완료</div>
                  <div style={{ color: 'var(--t2)' }}>
                    다음 단계: <strong>배포 버튼</strong>을 클릭해{' '}
                    <code style={{ color: 'var(--cyan)', fontSize: 10 }}>k8s/argocd-admin/</code> 파일을 생성한 후<br />
                    <code style={{ color: 'var(--amber)', fontSize: 10 }}>bash k8s/argocd-admin/setup.sh</code>로 Client Secret을 주입하세요.
                  </div>
                </div>
              )}
            </div>
          )}

          <Btn variant="primary" fullWidth disabled={!canSetupSso || busySso || !!ssoAllOk}
            onClick={handleSsoSetup}>
            {busySso ? '⟳ 등록 중...'
              : ssoAllOk ? '✓ GitHub Variable 등록 완료'
                : !repoValid ? '배포 대상 레포를 먼저 선택하세요'
                  : 'GitHub에 SSO Client ID 등록'}
          </Btn>
        </div>
      )}
    </section>
  )
}

// ── 팀 수 계산 헬퍼 (미리보기용) ─────────────────────────
function uniqueTeamCount(teams) {
  return [...new Set(teams.map(t => t.team).filter(Boolean))].length
}

function RepoSelector({ repos, value, onChange }) {
  const [search, setSearch] = useState('')
  const filtered = repos.filter(r =>
    r.full_name.toLowerCase().includes(search.toLowerCase())
  ).slice(0, 50)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="레포 검색..."
        style={{
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid var(--border2)',
          borderRadius: 'var(--r)',
          color: 'var(--t1)', padding: '7px 12px',
          fontSize: 12, fontFamily: 'var(--mono)',
          outline: 'none',
        }}
      />
      <div style={{
        maxHeight: 240, overflowY: 'auto',
        border: '1px solid var(--border2)', borderRadius: 'var(--r)',
        background: 'rgba(255,255,255,0.02)',
      }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 16, textAlign: 'center', color: 'var(--t3)', fontSize: 11 }}>
            {repos.length === 0 ? '레포가 없습니다' : '검색 결과 없음'}
          </div>
        ) : (
          filtered.map(r => {
            const selected = value === r.full_name
            return (
              <button key={r.full_name} onClick={() => onChange(r.full_name)} style={{
                width: '100%', padding: '8px 12px',
                display: 'flex', alignItems: 'center', gap: 8,
                background: selected ? 'rgba(96,165,250,0.14)' : 'transparent',
                border: 'none', borderBottom: '1px solid var(--border)',
                color: selected ? 'var(--blue)' : 'var(--t1)',
                fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'left',
                cursor: 'pointer', transition: 'background .1s',
              }}
                onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: selected ? 'var(--blue)' : 'var(--t3)',
                  flexShrink: 0,
                }} />
                <span style={{ flex: 1 }}>{r.full_name}</span>
                {r.private && (
                  <span style={{ fontSize: 9, color: 'var(--amber)', background: 'rgba(251,191,36,0.1)', padding: '1px 5px', borderRadius: 3 }}>
                    Private
                  </span>
                )}
              </button>
            )
          })
        )}
      </div>
      <div style={{ fontSize: 10, color: 'var(--t3)' }}>
        {filtered.length} / {repos.length} repos
      </div>
    </div>
  )
}
