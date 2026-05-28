import { useState, useEffect, useRef } from 'react'

const API_BASE = 'http://localhost:4000'

// ── 서비스 타입 분류 ──────────────────────────────────────
function classifyService(svc) {
  const frontendTypes = ['nginx', 'react-nginx', 'nextjs']
  const dbTypes = ['mysql', 'postgresql', 'redis', 'mongodb', 'elasticsearch']
  if (frontendTypes.includes(svc.type)) return 'frontend'
  if (dbTypes.includes(svc.type)) return 'db'
  return 'backend'
}

// ── 업타임 포맷 ────────────────────────────────────────────
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${h}h ${m}m ${s}s`
}

// ── LIVE 인디케이터 ─────────────────────────────────────────
function LiveDot({ color = 'var(--green)' }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block', animation: 'pulse 1.4s ease-in-out infinite' }} />
      <span style={{ position: 'absolute', top: 0, left: 0, width: 8, height: 8, borderRadius: '50%', background: color, opacity: 0.4, animation: 'pulse 1.4s ease-in-out infinite', transform: 'scale(2)' }} />
    </span>
  )
}

// ── 상태 카드 ─────────────────────────────────────────────
function StatusCard({ label, value, color, icon, subtitle }) {
  return (
    <div style={{ padding: '12px', borderRadius: 'var(--r2)', background: `${color}08`, border: `1px solid ${color}28`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div>
        <div style={{ fontSize: 9, color: 'var(--t3)', marginBottom: 3, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</div>
        <div style={{ fontSize: 13, fontWeight: 700, color }}>{value}</div>
        {subtitle && <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>{subtitle}</div>}
      </div>
      <div style={{ fontSize: 20, color, opacity: 0.7 }}>{icon}</div>
    </div>
  )
}

// ── 섹션 헤더 ─────────────────────────────────────────────
function SHead({ children }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--blue)', letterSpacing: '0.12em', textTransform: 'uppercase', paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
      {children}
    </div>
  )
}

export default function DemoMode({ services, proj, ns }) {
  const [active, setActive] = useState(false)
  const [uptime, setUptime] = useState(0)
  const timerRef = useRef(null)
  const pollRef = useRef(null)

  // ── 상태 (API에서 자동 가져옴) ───────────────────────────
  const [githubStatus, setGithubStatus] = useState(null)   // { status, conclusion, url }
  const [argoApps, setArgoApps] = useState([])             // [{ name, sync, health }]
  const [pods, setPods] = useState([])                     // [{ podName, status, reason, ready, restarts }]
  const [ingressURLs, setIngressURLs] = useState([])       // [{ name, url }]
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(null)

  // ── API 호출 ─────────────────────────────────────────────
  const fetchAll = async () => {
    try {
      // GitHub Actions 상태
      const ghRes = await fetch(`${API_BASE}/api/demo/github/status`)
      if (ghRes.ok) {
        const ghData = await ghRes.json()
        if (ghData.length > 0) setGithubStatus(ghData[0])
      }
    } catch (_) {}

    try {
      // Argo CD 상태
      const argoRes = await fetch(`${API_BASE}/api/demo/argocd/applications?project=${proj}`)
      if (argoRes.ok) {
        const argoData = await argoRes.json()
        setArgoApps(argoData.applications || [])
      }
    } catch (_) {}

    try {
      // Pod 상태
      const podRes = await fetch(`${API_BASE}/api/demo/pods/${ns}`)
      if (podRes.ok) {
        const podData = await podRes.json()
        setPods(podData)
      }
    } catch (_) {}

    try {
      // Ingress URL
      const ingRes = await fetch(`${API_BASE}/api/demo/ingress/${ns}`)
      if (ingRes.ok) {
        const ingData = await ingRes.json()
        setIngressURLs(ingData.urls || [])
      }
    } catch (_) {}
  }

  // ── 데모 시작 ─────────────────────────────────────────────
  const startDemo = async () => {
    setUptime(0)
    setActive(true)
    setLoading(true)
    await fetchAll()
    setLoading(false)
  }

  // ── 데모 중단 ─────────────────────────────────────────────
  const stopDemo = () => {
    setActive(false)
    clearInterval(timerRef.current)
    clearInterval(pollRef.current)
  }

  // ── 업타임 타이머 ─────────────────────────────────────────
  useEffect(() => {
    if (!active) return
    timerRef.current = setInterval(() => setUptime(u => u + 1), 1000)
    return () => clearInterval(timerRef.current)
  }, [active])

  // ── 30초마다 자동 폴링 ────────────────────────────────────
  useEffect(() => {
    if (!active) return
    pollRef.current = setInterval(fetchAll, 30000)
    return () => clearInterval(pollRef.current)
  }, [active, proj, ns])

  // ── URL 복사 ──────────────────────────────────────────────
  const copyURL = (key, url) => {
    navigator.clipboard?.writeText(url)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  // ── 상태 집계 ─────────────────────────────────────────────
  const githubColor = !githubStatus ? 'var(--t3)'
    : githubStatus.conclusion === 'success' ? 'var(--green)'
    : githubStatus.status === 'in_progress' ? 'var(--amber)'
    : 'var(--red)'
  const githubLabel = !githubStatus ? '미확인'
    : githubStatus.conclusion === 'success' ? 'Success'
    : githubStatus.status === 'in_progress' ? 'Running'
    : 'Failed'

  const argoSynced = argoApps.length > 0 && argoApps.every(a => a.sync === 'Synced')
  const argoHealthy = argoApps.length > 0 && argoApps.every(a => a.health === 'Healthy')
  const argoSyncLabel = argoApps.length === 0 ? '미확인' : argoSynced ? 'Synced' : 'OutOfSync'
  const argoHealthLabel = argoApps.length === 0 ? '미확인' : argoHealthy ? 'Healthy' : 'Degraded'

  const runningPods = pods.filter(p => p.status === 'Running').length
  const failedPods = pods.filter(p => p.status === 'Failed' || p.reason?.includes('BackOff') || p.reason?.includes('Error'))
  const podLabel = pods.length === 0 ? '미확인' : failedPods.length > 0 ? 'Failed' : `${runningPods}/${pods.length} Running`
  const podColor = pods.length === 0 ? 'var(--t3)' : failedPods.length > 0 ? 'var(--red)' : 'var(--green)'

  const urlOk = ingressURLs.length > 0
  const dbServices = services.filter(s => classifyService(s) === 'db')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── 데모 시작/중단 버튼 ── */}
      {!active ? (
        <button onClick={startDemo} style={{
          padding: '10px 28px', borderRadius: 'var(--r)',
          background: 'linear-gradient(135deg, #529cff, #1d4ed8)',
          border: 'none', color: 'white', fontSize: 12, fontWeight: 600,
          cursor: 'pointer', fontFamily: 'var(--mono)',
          boxShadow: '0 4px 20px rgba(82,156,255,0.3)',
        }}>
          🚀 데모 시작
        </button>
      ) : (
        <>
          {/* ── 업타임 바 ── */}
          <div style={{ padding: '10px 14px', borderRadius: 'var(--r2)', background: 'rgba(34,233,160,0.07)', border: '1px solid rgba(34,233,160,0.25)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <LiveDot />
              <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 600, marginLeft: 6 }}>LIVE</span>
            </div>
            <span style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>업타임: {formatUptime(uptime)}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setLoading(true); fetchAll().then(() => setLoading(false)) }} style={{
                padding: '4px 12px', borderRadius: 'var(--r)',
                border: '1px solid var(--border2)', background: 'transparent',
                color: 'var(--t2)', fontSize: 11, cursor: 'pointer',
              }}>{loading ? '...' : '↻ 새로고침'}</button>
              <button onClick={stopDemo} style={{
                padding: '4px 12px', borderRadius: 'var(--r)',
                border: '1px solid rgba(248,95,109,0.3)', background: 'transparent',
                color: 'var(--red)', fontSize: 11, cursor: 'pointer',
              }}>중단</button>
            </div>
          </div>

          {/* ── 상태 카드 5개 ── */}
          <section>
            <SHead>배포 상태 {loading && <span style={{ color: 'var(--t3)', fontWeight: 400 }}>조회 중...</span>}</SHead>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
              <StatusCard
                label="GitHub Actions"
                value={githubLabel}
                color={githubColor}
                icon={githubLabel === 'Success' ? '✓' : githubLabel === 'Running' ? '↻' : '?'}
                subtitle={githubStatus?.name?.slice(0, 20)}
              />
              <StatusCard
                label="Argo CD Sync"
                value={argoSyncLabel}
                color={argoSynced ? 'var(--green)' : argoApps.length === 0 ? 'var(--t3)' : 'var(--amber)'}
                icon={argoSynced ? '✓' : '↻'}
                subtitle={`${argoApps.length} apps`}
              />
              <StatusCard
                label="Argo CD Health"
                value={argoHealthLabel}
                color={argoHealthy ? 'var(--green)' : argoApps.length === 0 ? 'var(--t3)' : 'var(--red)'}
                icon={argoHealthy ? '♥' : '✕'}
              />
              <StatusCard
                label="Pod Ready"
                value={podLabel}
                color={podColor}
                icon={failedPods.length > 0 ? '✕' : pods.length === 0 ? '?' : '✓'}
                subtitle={`${pods.length} pods total`}
              />
              <StatusCard
                label="외부 URL"
                value={urlOk ? `${ingressURLs.length}개 노출` : '미확인'}
                color={urlOk ? 'var(--green)' : 'var(--t3)'}
                icon={urlOk ? '🌐' : '—'}
              />
            </div>
          </section>

          {/* ── 서비스별 외부 URL ── */}
          <section>
            <SHead>외부 URL</SHead>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {ingressURLs.length === 0 && (
                <div style={{ fontSize: 11, color: 'var(--t3)', padding: '10px', textAlign: 'center' }}>
                  Ingress URL을 가져오는 중이거나 설정되지 않았습니다
                </div>
              )}
              {ingressURLs.map((item, i) => (
                <div key={i} style={{ padding: '10px 12px', borderRadius: 'var(--r2)', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border2)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: 'var(--t2)', fontWeight: 600 }}>{item.name}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--cyan)', flex: 1, wordBreak: 'break-all' }}>{item.url}</span>
                    <button onClick={() => copyURL(i, item.url)} style={{
                      padding: '4px 10px', borderRadius: 'var(--r)', fontSize: 10, cursor: 'pointer', flexShrink: 0,
                      border: '1px solid rgba(34,233,160,0.3)', background: 'transparent', color: 'var(--green)',
                    }}>{copied === i ? '✓ 복사됨' : '복사'}</button>
                    <a href={item.url} target="_blank" rel="noreferrer" style={{
                      padding: '4px 10px', borderRadius: 'var(--r)', fontSize: 10, cursor: 'pointer', flexShrink: 0,
                      border: '1px solid rgba(96,165,250,0.3)', background: 'transparent', color: 'var(--blue)',
                      textDecoration: 'none',
                    }}>열기 ↗</a>
                  </div>
                </div>
              ))}
              {/* DB 외부 노출 차단 */}
              {dbServices.map(svc => (
                <div key={svc.id} style={{ padding: '8px 12px', borderRadius: 'var(--r2)', background: 'rgba(248,95,109,0.04)', border: '1px solid rgba(248,95,109,0.15)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>🗄 {svc.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--red)', opacity: 0.7 }}>🔒 외부 노출 차단</span>
                </div>
              ))}
            </div>
          </section>

          {/* ── Pod 상태 대시보드 ── */}
          <section>
            <SHead>Pod 상태 <span style={{ color: 'var(--t3)', fontWeight: 400 }}>— {pods.length} pods</span></SHead>
            {pods.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--t3)', padding: '10px', textAlign: 'center', marginTop: 8 }}>
                {loading ? '조회 중...' : `네임스페이스 "${ns}" 에서 Pod를 찾을 수 없습니다`}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 80px 80px 50px', gap: 8, padding: '4px 10px', fontSize: 9, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  <span>Name</span><span>Status</span><span>원인</span><span>재시작</span>
                </div>
                {pods.map((pod, i) => {
                  const statusColor = pod.status === 'Running' ? 'var(--green)' : pod.status === 'Pending' ? 'var(--amber)' : 'var(--red)'
                  return (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 80px 80px 50px', gap: 8, padding: '6px 10px', borderRadius: 'var(--r)', background: 'rgba(255,255,255,0.02)', alignItems: 'center' }}>
                      <span style={{ fontSize: 10, color: 'var(--t1)', fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>{pod.podName}</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: statusColor }}>{pod.status}</span>
                      <span style={{ fontSize: 9, color: 'var(--red)', wordBreak: 'break-word' }}>{pod.reason !== pod.status ? pod.reason : '—'}</span>
                      <span style={{ fontSize: 10, color: pod.restarts > 0 ? 'var(--amber)' : 'var(--t3)' }}>{pod.restarts}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* ── Argo CD 앱 상태 ── */}
          {argoApps.length > 0 && (
            <section>
              <SHead>Argo CD Applications</SHead>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 80px 80px', gap: 8, padding: '4px 10px', fontSize: 9, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  <span>Name</span><span>Sync</span><span>Health</span>
                </div>
                {argoApps.map((app, i) => {
                  const syncColor = app.sync === 'Synced' ? 'var(--green)' : 'var(--amber)'
                  const healthColor = app.health === 'Healthy' ? 'var(--green)' : 'var(--red)'
                  return (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 80px 80px', gap: 8, padding: '6px 10px', borderRadius: 'var(--r)', background: 'rgba(255,255,255,0.02)', alignItems: 'center' }}>
                      <span style={{ fontSize: 10, color: 'var(--t1)', fontFamily: 'var(--mono)' }}>{app.name}</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: syncColor }}>{app.sync}</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: healthColor }}>{app.health}</span>
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
