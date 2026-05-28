import { useState } from 'react'
import { Input, Btn } from './Ui'
import { buildControlFiles } from '../generators/multiUser'
import { encryptForGithub } from '../utils/sealedBox'

// ════════ GitHub API 헬퍼 ════════════════════════════════

async function ghPushFiles(pat, owner, repo, files) {
  const base = `https://api.github.com/repos/${owner}/${repo}/contents`
  const headers = { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' }
  const results = []
  for (const [path, content] of Object.entries(files)) {
    try {
      let sha
      try {
        const r = await fetch(`${base}/${path}`, { headers })
        if (r.ok) { const d = await r.json(); sha = d.sha }
      } catch (_) {}
      const r = await fetch(`${base}/${path}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `chore: grad-deploy multi-user [${path}]`,
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

async function ghCreateRepo(pat, name, isPrivate = true) {
  const r = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      Authorization: `token ${pat}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github.v3+json',
    },
    body: JSON.stringify({ name, private: isPrivate, auto_init: true, description: 'Grad-Deploy control repo' }),
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    if (err.errors?.some(e => e.message?.includes('already exists'))) return null // 이미 존재
    throw new Error(`레포 생성 실패 (${r.status}): ${err.message || ''}`)
  }
  return await r.json()
}

async function ghCheckRepo(pat, owner, repo) {
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' },
  })
  return r.ok
}

// ════════ Argo CD API ════════════════════════════════════

async function argoApplyRootApp(serverUrl, token, controlRepo) {
  const server = serverUrl.replace(/\/$/, '')
  const repoUrl = `https://github.com/${controlRepo}`
  const appName = 'root-app'

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  // 존재 여부 확인
  const checkRes = await fetch(`${server}/api/v1/applications/${appName}`, { headers })
  if (checkRes.status === 404) {
    const createRes = await fetch(`${server}/api/v1/applications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        metadata: { name: appName, namespace: 'argocd' },
        spec: {
          project: 'default',
          source: { repoURL: repoUrl, targetRevision: 'HEAD', path: 'apps' },
          destination: { server: 'https://kubernetes.default.svc', namespace: 'argocd' },
          syncPolicy: { automated: { prune: true, selfHeal: true } },
        },
      }),
    })
    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({}))
      throw new Error(`root-app 생성 실패 (${createRes.status}): ${err.message || ''}`)
    }
    return 'created'
  } else if (checkRes.ok) {
    return 'exists'
  } else {
    throw new Error(`Argo CD 연결 실패 (${checkRes.status}): 서버 URL과 토큰을 확인하세요`)
  }
}

// ════════ 컴포넌트 ════════════════════════════════════════

export default function MultiUserPanel({ state, set, addMultiUser, delMultiUser, updMultiUser }) {
  const [pat, setPat] = useState('')
  const [argoServer, setArgoServer] = useState('')
  const [argoToken, setArgoToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState(null)

  const users = state.multiUsers
  const controlRepo = state.controlRepo

  const canDeploy = pat && controlRepo && controlRepo.includes('/') &&
    users.length > 0 && users.every(u => u.name && u.namespace && u.repoUrl)

  const handleDeploy = async () => {
    setBusy(true)
    setResults(null)
    const log = []
    try {
      const [owner, repo] = controlRepo.split('/')
      if (!owner || !repo) throw new Error('Control 레포를 owner/repo 형식으로 입력하세요')

      // 레포 존재 확인 → 없으면 생성
      const exists = await ghCheckRepo(pat, owner, repo)
      if (!exists) {
        log.push({ label: `레포 생성: ${controlRepo}`, ok: true })
        await ghCreateRepo(pat, repo)
        // 생성 직후 API 반영 대기
        await new Promise(r => setTimeout(r, 1500))
      } else {
        log.push({ label: `레포 확인: ${controlRepo}`, ok: true })
      }

      // YAML 파일 생성 & 푸시
      const files = buildControlFiles(controlRepo, users)
      const pushResults = await ghPushFiles(pat, owner, repo, files)
      for (const r of pushResults) {
        log.push({ label: r.path, ok: r.ok, status: r.status, error: r.error })
      }

      // Argo CD root-app 적용 (선택)
      if (argoServer && argoToken) {
        try {
          const status = await argoApplyRootApp(argoServer, argoToken, controlRepo)
          log.push({ label: 'Argo CD root-app', ok: true, status: status === 'created' ? '생성됨' : '이미 존재' })
        } catch (e) {
          log.push({ label: 'Argo CD root-app', ok: false, error: e.message })
        }
      }

      setResults({ ok: pushResults.every(r => r.ok), log })
    } catch (e) {
      setResults({ ok: false, log, error: e.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* 컨트롤 레포 */}
      <Section title="Control 레포지토리" icon="⊕">
        <Input
          label="레포 (owner/repo)"
          value={controlRepo}
          onChange={v => set({ controlRepo: v })}
          placeholder="myorg/k8s-control"
          hint="App-of-Apps 패턴의 루트 Application이 이 레포의 apps/ 폴더를 감시합니다"
        />
      </Section>

      {/* 사용자 목록 */}
      <Section
        title="사용자 목록"
        icon="◈"
        action={
          <button onClick={addMultiUser} style={addBtnStyle}>
            + 사용자 추가
          </button>
        }
      >
        {users.length === 0 && (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--t3)', fontSize: 12,
            border: '1px dashed var(--border2)', borderRadius: 8 }}>
            아래 버튼으로 사용자를 추가하세요
          </div>
        )}
        {users.map((user, idx) => (
          <UserRow key={user.id} user={user} idx={idx}
            onUpdate={(patch) => updMultiUser(user.id, patch)}
            onDelete={() => delMultiUser(user.id)}
          />
        ))}
      </Section>

      {/* 배포 설정 */}
      <Section title="배포 설정" icon="▶">
        <Input
          label="GitHub PAT"
          value={pat}
          onChange={setPat}
          placeholder="ghp_..."
          secret
          hint="Control 레포에 파일을 푸시할 권한이 필요합니다 (repo scope)"
        />
      </Section>

      {/* Argo CD 연결 (선택) */}
      <Section title="Argo CD 연결 (선택)" icon="◉">
        <div style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(96,165,250,0.07)',
          border: '1px solid rgba(96,165,250,0.2)', fontSize: 12, color: 'var(--t2)', marginBottom: 4 }}>
          입력 시 root-app Application을 Argo CD에 자동으로 생성합니다.<br/>
          생략하면 YAML만 레포에 푸시됩니다 (kubectl apply -f root-app.yaml 수동 실행 필요).
        </div>
        <Input label="Argo CD 서버 URL" value={argoServer} onChange={setArgoServer}
          placeholder="https://xxx.ngrok-free.app" />
        <div style={{ marginTop: 10 }}>
          <Input label="Argo CD 토큰" value={argoToken} onChange={setArgoToken}
            placeholder="eyJhbGciOiJS..." secret />
        </div>
      </Section>

      {/* 배포 버튼 */}
      <button
        onClick={handleDeploy}
        disabled={!canDeploy || busy}
        style={{
          padding: '12px 0', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 700,
          cursor: canDeploy && !busy ? 'pointer' : 'not-allowed',
          background: canDeploy && !busy
            ? 'linear-gradient(135deg,#3b82f6,#1d4ed8)'
            : 'rgba(255,255,255,0.06)',
          color: canDeploy && !busy ? 'white' : 'var(--t3)',
          transition: 'all .2s',
          fontFamily: 'var(--mono)',
        }}
      >
        {busy ? '배포 중...' : 'Control 레포 배포'}
      </button>

      {!canDeploy && !busy && (
        <div style={{ fontSize: 11, color: 'var(--t3)', textAlign: 'center', marginTop: -12 }}>
          {!pat ? 'GitHub PAT 필요' :
           !controlRepo.includes('/') ? 'Control 레포를 owner/repo 형식으로 입력하세요' :
           users.length === 0 ? '사용자를 1명 이상 추가하세요' :
           '모든 사용자의 이름, Namespace, 레포 URL을 입력하세요'}
        </div>
      )}

      {/* 결과 */}
      {results && (
        <ResultLog results={results} />
      )}

      {/* 사용 안내 */}
      <InfoBox />
    </div>
  )
}

// ── 사용자 행 ────────────────────────────────────────────

function UserRow({ user, idx, onUpdate, onDelete }) {
  return (
    <div style={{
      border: '1px solid var(--border2)', borderRadius: 10,
      padding: '14px 16px', background: 'rgba(255,255,255,0.02)',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue)', letterSpacing: '0.08em' }}>
          USER {idx + 1}
        </span>
        <button onClick={onDelete} style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--t3)', fontSize: 16, lineHeight: 1, padding: '2px 6px',
          borderRadius: 4,
        }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--t3)'}
        >✕</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <MiniInput label="이름 (Argo CD App명 접두사)" value={user.name}
          onChange={v => onUpdate({ name: v })} placeholder="user1" />
        <MiniInput label="Namespace" value={user.namespace}
          onChange={v => onUpdate({ namespace: v })} placeholder="user1-ns" />
      </div>
      <MiniInput label="사용자 레포 URL" value={user.repoUrl}
        onChange={v => onUpdate({ repoUrl: v })} placeholder="https://github.com/user1/my-app" />
    </div>
  )
}

// ── 결과 로그 ────────────────────────────────────────────

function ResultLog({ results }) {
  return (
    <div style={{
      border: `1px solid ${results.ok ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.3)'}`,
      borderRadius: 10, padding: '14px 16px',
      background: results.ok ? 'rgba(74,222,128,0.05)' : 'rgba(248,113,113,0.05)',
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: results.ok ? 'var(--green)' : 'var(--red)', marginBottom: 10 }}>
        {results.ok ? '✓ 배포 완료' : results.error ? `✕ 오류: ${results.error}` : '✕ 일부 실패'}
      </div>
      {results.log.map((item, i) => (
        <div key={i} style={{ fontSize: 11, fontFamily: 'var(--mono)', display: 'flex', gap: 8,
          color: item.ok ? 'var(--t2)' : 'var(--red)', marginBottom: 3 }}>
          <span>{item.ok ? '✓' : '✕'}</span>
          <span style={{ flex: 1 }}>{item.label}</span>
          <span style={{ color: 'var(--t3)' }}>
            {item.error || item.status || ''}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── 사용 안내 ────────────────────────────────────────────

function InfoBox() {
  return (
    <div style={{
      border: '1px solid var(--border2)', borderRadius: 10,
      padding: '14px 16px', background: 'rgba(255,255,255,0.02)',
      fontSize: 12, color: 'var(--t2)', lineHeight: 1.8,
    }}>
      <div style={{ fontWeight: 700, color: 'var(--t1)', marginBottom: 8, fontSize: 13 }}>
        ⊕ App-of-Apps 패턴 동작 방식
      </div>
      <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <li>Control 레포의 <code style={code}>apps/</code> 폴더에 사용자별 Application/AppProject YAML 생성</li>
        <li>Argo CD <strong>root-app</strong>이 해당 폴더를 감시 → 변경 시 자동 동기화</li>
        <li>각 사용자 Application은 해당 사용자의 레포 <code style={code}>k8s/overlays/production</code>을 배포</li>
        <li>AppProject가 sourceRepo/destination을 해당 사용자 범위로 제한 (격리)</li>
      </ol>
      <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 6,
        background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)',
        color: 'var(--amber)', fontSize: 11 }}>
        ⚠ Argo CD 연결 생략 시: <code style={code}>kubectl apply -f root-app.yaml</code> 수동 실행 필요
      </div>
    </div>
  )
}

// ── 헬퍼 컴포넌트 ────────────────────────────────────────

function Section({ title, icon, children, action }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          {icon} {title}
        </span>
        {action}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {children}
      </div>
    </div>
  )
}

function MiniInput({ label, value, onChange, placeholder, secret }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--t3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {label}
      </span>
      <input
        type={secret ? 'password' : 'text'}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={secret ? 'off' : undefined}
        style={{
          background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border2)',
          borderRadius: 'var(--r)', color: 'var(--t1)', padding: '7px 10px',
          fontSize: 12, fontFamily: 'var(--mono)', width: '100%', outline: 'none',
          transition: 'border-color .15s, background .15s',
        }}
        onFocus={e => { e.target.style.borderColor = 'var(--blue)'; e.target.style.background = 'rgba(96,165,250,0.07)' }}
        onBlur={e => { e.target.style.borderColor = 'var(--border2)'; e.target.style.background = 'rgba(255,255,255,0.06)' }}
      />
    </div>
  )
}

const addBtnStyle = {
  fontSize: 11, fontWeight: 600, cursor: 'pointer',
  padding: '5px 12px', borderRadius: 5,
  background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.3)',
  color: 'var(--blue)', fontFamily: 'var(--mono)',
  transition: 'all .15s',
}

const code = {
  fontFamily: 'var(--mono)', fontSize: 11,
  background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 3,
}
