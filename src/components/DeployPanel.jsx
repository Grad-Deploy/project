import { useState } from 'react'
import { Input, Btn } from './Ui'
import { buildManifestYAML, genNetworkPolicies, genGitHubActions, genArgoCDApp, genBaseKustomization, genOverlayKustomization } from '../generators/k8s'
import { encryptForGithub } from '../utils/sealedBox'

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

async function ghPushFiles(pat, owner, repo, files) {
  const base = `https://api.github.com/repos/${owner}/${repo}/contents`
  const results = []
  for (const [path, content] of Object.entries(files)) {
    try {
      let sha
      try {
        const r = await fetch(`${base}/${path}`, {
          headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' },
        })
        if (r.ok) { const d = await r.json(); sha = d.sha }
      } catch (_) { }
      const r = await fetch(`${base}/${path}`, {
        method: 'PUT',
        headers: { Authorization: `token ${pat}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github.v3+json' },
        body: JSON.stringify({
          message: `chore: grad-deploy [${path}]`,
          content: btoa(unescape(encodeURIComponent(content))),
          ...(sha ? { sha } : {}),
        }),
      })
      results.push({ path, ok: r.ok, status: r.status })
    } catch (e) {
      results.push({ path, ok: false, error: e.message })
    }
  }
  return results
}

// GitHub Secrets API
async function ghSetSecret(pat, owner, repo, secretName, secretValue) {
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
    const err = await r.json().catch(() => ({}))
    throw new Error(`Argo CD 인증 실패 (${r.status}): ${err.message || '서버 URL과 계정 정보를 확인하세요'}`)
  }
  const { token } = await r.json()
  if (!token) throw new Error('서버에서 토큰을 받지 못했습니다')
  return token
}

// GitHub Actions Variable 생성/업데이트
async function ghSetVariable(pat, owner, repo, name, value) {
  const base = `https://api.github.com/repos/${owner}/${repo}/actions/variables`
  const headers = { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' }

  const checkRes = await fetch(`${base}/${name}`, { headers })
  const exists = checkRes.ok

  const r = await fetch(exists ? `${base}/${name}` : base, {
    method: exists ? 'PATCH' : 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(exists ? { value } : { name, value }),
  })
  if (!r.ok && r.status !== 204) {
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
  const [pendingArgo, setPendingArgo] = useState(null) // { registerUrl, registerSecret } — 새 레포 생성 시 첫 push에 함께 적용

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
    setPendingArgo(null)
  }

  // ── 배포 실행
  const handleDeploy = async () => {
    setBusy(true); setError(null); setResults(null)

    try {
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

      // 등록 서비스 pending setup 적용 — 새 레포 생성 전 미리 설정한 경우 첫 push에 함께 등록
      if (pendingArgo) {
        const regUrl = pendingArgo.registerUrl.replace(/\/$/, '')
        try { await ghSetVariable(pat, owner, repo, 'REGISTER_URL', regUrl) } catch (_) {}
        try { await ghSetSecret(pat, owner, repo, 'REGISTER_SECRET', pendingArgo.registerSecret) } catch (_) {}
      }

      // 2. 매니페스트 + CI 파일 생성
      const files = {}
      services.forEach(svc => {
        files[`k8s/base/${svc.name}/manifest.yaml`] = buildManifestYAML([svc], state.ns)
        files[`k8s/base/${svc.name}/kustomization.yaml`] = genBaseKustomization(svc)
      })
      files['k8s/overlays/production/networkpolicy.yaml'] = genNetworkPolicies(services, state.ns)
      files['k8s/overlays/production/kustomization.yaml'] = genOverlayKustomization(services, state.ns)
      // 기존 ci.yml에서 서비스 목록 읽어서 현재 서비스와 병합
      // (2차 이후 push 시 이전 서비스 job이 사라지는 문제 방지)
      const existingSvcNames = await ghFetchExistingServices(pat, owner, repo)
      const currentSvcNames = new Set(services.map(s => s.name))
      // 기존에 있던 서비스 중 현재 목록에 없는 것만 추가 (중복 방지)
      const missingSvcNames = existingSvcNames.filter(n => !currentSvcNames.has(n))

      // useStore의 SERVICE_TEMPLATES 기반으로 최소 서비스 객체 복원
      const { SERVICE_TEMPLATES } = await import('../engines/guardrail')
      const missingServices = missingSvcNames.map(name => {
        // 이름에서 타입 추측 (spring-svc → spring-boot, mysql-svc → mysql 등)
        const typeGuess = (() => {
          if (name.includes('spring')) return 'spring-boot'
          if (name.includes('mysql')) return 'mysql'
          if (name.includes('redis')) return 'redis'
          if (name.includes('mongo')) return 'mongodb'
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
          deps: [], env: {}, expose: false
        }
      })

      const allServices = [...services, ...missingServices]
      files['.github/workflows/ci.yml'] = genGitHubActions(allServices, {
        proj: state.proj,
        ns: state.ns,
        registry,
        dockerhubUser,
      })
      files['k8s/argo-app.yaml'] = genArgoCDApp({
        proj: state.proj,
        repo: `https://github.com/${owner}/${repo}`,
        ns: state.ns,
      })

      // 3. 파일 push
      const pushResults = await ghPushFiles(pat, owner, repo, files)

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

      setResults({
        repo: `${owner}/${repo}`,
        files: pushResults,
        secrets: secretsResults,
        registry,
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
              hint="필요 권한: repo, workflow · 세션 메모리에만 보관 · 새로고침 시 소멸"
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

      {/* ── 4단계: 플랫폼 등록 서비스 연동 ── */}
      {ghUser && (
        <RegisterSetupSection
          pat={pat}
          owner={selectedRepo ? selectedRepo.split('/')[0] : ''}
          repo={selectedRepo ? selectedRepo.split('/')[1] : ''}
          onPendingReady={(registerUrl, registerSecret) => setPendingArgo({ registerUrl, registerSecret })}
          pendingReady={!!pendingArgo}
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
            background: 'rgba(74,222,128,0.07)', border: '1px solid rgba(74,222,128,0.25)',
          }}>
            <div style={{ fontSize: 12, color: 'var(--green)', fontWeight: 600, marginBottom: 6 }}>
              ✓ Push 완료 → {results.repo}
            </div>
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
                display: 'flex', justifyContent: 'space-between',
                fontSize: 11, padding: '5px 9px', borderRadius: 4,
                background: r.ok ? 'rgba(74,222,128,0.05)' : 'rgba(248,113,113,0.06)',
              }}>
                <span style={{ color: 'var(--t2)', fontFamily: 'var(--mono)' }}>{r.path}</span>
                <span style={{ color: r.ok ? 'var(--green)' : 'var(--red)' }}>
                  {r.ok ? `✓ ${r.status}` : `✕ ${r.error || r.status}`}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

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

function RegisterSetupSection({ pat, owner, repo, onPendingReady, pendingReady }) {
  const [registerUrl, setRegisterUrl] = useState('')
  const [registerSecret, setRegisterSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [setupResults, setSetupResults] = useState(null)

  const pendingMode = !owner || !repo  // 레포가 아직 없는 경우 (새 레포 생성 전)

  const urlTrimmed = registerUrl.trim().replace(/\/$/, '')
  const canSetup   = urlTrimmed && registerSecret.trim()
  const allOk      = setupResults?.every(r => r.ok)

  const handleSetup = async () => {
    setBusy(true); setError(null); setSetupResults(null)
    try {
      if (!urlTrimmed)              throw new Error('등록 서비스 URL을 입력하세요')
      if (!registerSecret.trim())   throw new Error('공유 시크릿을 입력하세요')

      // 레포가 없는 경우 — 배포 버튼 클릭 시 자동 등록되도록 상위에 저장
      if (pendingMode) {
        onPendingReady?.(urlTrimmed, registerSecret.trim())
        setSetupResults([{ name: '설정 저장됨', type: 'Pending', ok: true }])
        return
      }

      const r = []
      try {
        await ghSetVariable(pat, owner, repo, 'REGISTER_URL', urlTrimmed)
        r.push({ name: 'REGISTER_URL', type: 'Variable', ok: true })
      } catch (e) {
        r.push({ name: 'REGISTER_URL', type: 'Variable', ok: false, error: e.message })
      }
      try {
        await ghSetSecret(pat, owner, repo, 'REGISTER_SECRET', registerSecret.trim())
        r.push({ name: 'REGISTER_SECRET', type: 'Secret', ok: true })
      } catch (e) {
        r.push({ name: 'REGISTER_SECRET', type: 'Secret', ok: false, error: e.message })
      }
      setSetupResults(r)
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  return (
    <section>
      <SectionHead step="4">
        플랫폼 등록 서비스 연동
        <span style={{
          fontSize: 9, color: 'var(--t3)', marginLeft: 6,
          background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: 3,
        }}>선택</span>
      </SectionHead>

      {pendingMode ? (
        <div style={{
          marginTop: 10, padding: '8px 12px', borderRadius: 'var(--r)',
          background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.2)',
          fontSize: 11, color: 'var(--blue)', lineHeight: 1.7,
        }}>
          레포 선택 전에도 미리 설정할 수 있습니다.{' '}
          <strong>배포 버튼 클릭 시</strong> 레포 생성과 동시에 자동 등록되어
          <strong> 첫 push에서 바로 동기화</strong>됩니다.
        </div>
      ) : (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--t3)', lineHeight: 1.7 }}>
          등록 서비스 정보를 입력하면{' '}
          <code style={{ color: 'var(--cyan)', fontSize: 10 }}>REGISTER_URL</code> (Variable)과{' '}
          <code style={{ color: 'var(--cyan)', fontSize: 10 }}>REGISTER_SECRET</code> (Secret)을
          GitHub에 자동으로 등록합니다.
          이후 main 브랜치 push 시 CI가 등록 서비스를 호출하여 Argo CD Application을 자동 생성·동기화합니다.
        </div>
      )}

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Input
          label="등록 서비스 URL"
          value={registerUrl}
          onChange={v => setRegisterUrl(v)}
          placeholder="http://localhost:3000"
          hint="server/ 디렉토리의 등록 서비스 주소 (ngrok 사용 시 ngrok URL 입력)"
        />
        <Input
          label="공유 시크릿 (REGISTER_SECRET)"
          value={registerSecret}
          onChange={v => setRegisterSecret(v)}
          placeholder="your-strong-shared-secret"
          secret
          hint="서버 .env의 REGISTER_SECRET과 동일한 값 — GitHub Secret에 자동 등록됩니다"
        />

        {error && (
          <div style={{
            background: 'rgba(248,113,113,0.08)',
            border: '1px solid rgba(248,113,113,0.3)',
            borderRadius: 'var(--r)', padding: '10px 14px',
            fontSize: 11, color: 'var(--red)',
          }}>
            ✕ {error}
          </div>
        )}

        {setupResults && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {setupResults.map(r => (
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
                  {r.ok
                    ? r.type === 'Pending' ? '✓ 배포 시 자동 등록 예정' : '✓ 등록됨'
                    : `✕ ${r.error}`}
                </span>
              </div>
            ))}
            {allOk && !pendingMode && (
              <div style={{
                padding: '12px 14px', borderRadius: 'var(--r2)',
                background: 'linear-gradient(135deg, rgba(34,233,160,0.08), rgba(82,156,255,0.08))',
                border: '1px solid rgba(34,233,160,0.3)',
                fontSize: 11, lineHeight: 1.7,
              }}>
                <div style={{ fontWeight: 700, color: 'var(--green)', marginBottom: 6 }}>
                  ✓ US-03 인수 조건 충족
                </div>
                <div style={{ color: 'var(--t2)' }}>
                  · GitHub Push → CI → 등록 서비스 → Argo CD Sync <strong style={{ color: 'var(--green)' }}>자동</strong><br />
                  · 사용자는 Argo CD 토큰·URL을 직접 관리할 필요 없음<br />
                  · Self-healing: Argo CD <code style={{ color: 'var(--cyan)', fontSize: 10 }}>selfHeal: true</code> 적용 중
                </div>
              </div>
            )}
          </div>
        )}

        <Btn
          variant="primary"
          fullWidth
          disabled={!canSetup || busy || (!pendingMode && !!allOk)}
          onClick={handleSetup}
        >
          {busy
            ? '⟳ 등록 중...'
            : pendingMode
              ? pendingReady ? '✓ 배포 시 자동 등록 예정 (재설정 가능)' : '등록 서비스 설정 저장 (배포 시 자동 등록)'
              : allOk ? '✓ 등록 완료' : 'GitHub에 등록 서비스 설정 자동 등록'}
        </Btn>
      </div>
    </section>
  )
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
