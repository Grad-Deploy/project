import { useState, useEffect, useRef } from 'react'

// ── 서비스 타입 분류 ──────────────────────────────────────
function classifyService(svc) {
  const frontendTypes = ['nginx', 'react-nginx', 'nextjs']
  const dbTypes = ['mysql', 'postgresql', 'redis', 'mongodb', 'elasticsearch']
  if (frontendTypes.includes(svc.type)) return 'frontend'
  if (dbTypes.includes(svc.type)) return 'db'
  return 'backend'
}

// ── URL 접속 확인 ─────────────────────────────────────────
async function checkURL(url) {
  try {
    const res = await fetch(url, { method: 'GET', mode: 'no-cors', signal: AbortSignal.timeout(4000) })
    return true
  } catch {
    return false
  }
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

// ── Pod 실패 원인 배지 ────────────────────────────────────
const FAIL_REASONS = ['ImagePullBackOff', 'CrashLoopBackOff', 'Insufficient CPU', 'OOMKilled', 'Service/Ingress mismatch']

// ── POD 상태 선택 옵션 ────────────────────────────────────
const POD_STATUS_OPTIONS = ['Running', 'Pending', 'Failed', 'Completed']

export default function DemoMode({ services, proj, ns }) {
  const [active, setActive] = useState(false)
  const [uptime, setUptime] = useState(0)
  const timerRef = useRef(null)

  // ── 외부 URL 설정 (서비스별) ──────────────────────────
  const nonDbServices = services.filter(s => classifyService(s) !== 'db')
  const [urlMap, setUrlMap] = useState({})          // { svcId: url }
  const [urlStatus, setUrlStatus] = useState({})    // { svcId: true/false/null }
  const [copied, setCopied] = useState(null)        // 복사된 svcId

  // ── 상태 카드 수동 설정 ───────────────────────────────
  const [githubStatus, setGithubStatus] = useState('success')   // success | running | failed
  const [argoSync, setArgoSync] = useState('Synced')            // Synced | OutOfSync | Unknown
  const [argoHealth, setArgoHealth] = useState('Healthy')       // Healthy | Degraded | Progressing
  const [podStatuses, setPodStatuses] = useState({})            // { svcId: { status, reason } }

  // services 변경 시 podStatuses 초기화
  useEffect(() => {
    const init = {}
    services.forEach(s => {
      if (!podStatuses[s.id]) init[s.id] = { status: 'Running', reason: '' }
    })
    if (Object.keys(init).length > 0) setPodStatuses(p => ({ ...p, ...init }))
  }, [services])

  // ── URL 접속 확인 ─────────────────────────────────────
  const checkAllURLs = async () => {
    const results = {}
    for (const svc of nonDbServices) {
      const url = urlMap[svc.id]
      if (url) {
        results[svc.id] = await checkURL(url)
      } else {
        results[svc.id] = null
      }
    }
    setUrlStatus(results)
  }

  // ── 데모 시작 ─────────────────────────────────────────
  const startDemo = async () => {
    setUptime(0)
    setActive(true)
    await checkAllURLs()
  }

  // ── 데모 중단 ─────────────────────────────────────────
  const stopDemo = () => {
    setActive(false)
    clearInterval(timerRef.current)
  }

  // ── 업타임 타이머 ─────────────────────────────────────
  useEffect(() => {
    if (!active) return
    timerRef.current = setInterval(() => {
      setUptime(u => u + 1)
    }, 1000)
    return () => clearInterval(timerRef.current)
  }, [active])

  // ── URL 주기적 재확인 (30초마다) ─────────────────────
  useEffect(() => {
    if (!active) return
    const id = setInterval(checkAllURLs, 30000)
    return () => clearInterval(id)
  }, [active, urlMap])

  // ── URL 복사 ──────────────────────────────────────────
  const copyURL = (svcId, url) => {
    navigator.clipboard?.writeText(url)
    setCopied(svcId)
    setTimeout(() => setCopied(null), 2000)
  }

  // ── Pod 전체 상태 집계 ────────────────────────────────
  const allRunning = services.length > 0 && services.every(s => (podStatuses[s.id]?.status || 'Running') === 'Running')
  const anyFailed  = services.some(s => podStatuses[s.id]?.status === 'Failed')

  // ── URL 전체 상태 집계 ────────────────────────────────
  const allURLsOk = nonDbServices.length > 0 && nonDbServices.every(s => urlStatus[s.id] === true)
  const anyURLSet = nonDbServices.some(s => urlMap[s.id])

  const githubColor = { success: 'var(--green)', running: 'var(--amber)', failed: 'var(--red)' }[githubStatus]
  const githubIcon  = { success: '✓', running: '↻', failed: '✕' }[githubStatus]
  const githubLabel = { success: 'Success', running: 'Running', failed: 'Failed' }[githubStatus]

  // ── 렌더 ──────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── 설정 패널 (항상 표시) ── */}
      <section>
        <SHead>외부 URL 설정 (cloudflared tunnel)</SHead>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {nonDbServices.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--t3)', padding: '10px', textAlign: 'center' }}>
              서비스를 먼저 추가해주세요 (DB 제외)
            </div>
          )}
          {nonDbServices.map(svc => {
            const kind = classifyService(svc)
            const kindColor = kind === 'frontend' ? 'var(--blue)' : 'var(--purple)'
            return (
              <div key={svc.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: kindColor, minWidth: 60 }}>
                    {kind === 'frontend' ? '🌐 FRONT' : '⚙ BACK'}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--t2)', fontFamily: 'var(--mono)' }}>{svc.name}</span>
                </div>
                <input
                  value={urlMap[svc.id] || ''}
                  onChange={e => setUrlMap(m => ({ ...m, [svc.id]: e.target.value }))}
                  placeholder={`https://xxxx.trycloudflare.com/${kind === 'frontend' ? '' : 'health'}`}
                  style={{
                    background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border2)',
                    borderRadius: 'var(--r)', color: 'var(--t1)', padding: '7px 10px',
                    fontSize: 11, fontFamily: 'var(--mono)', width: '100%', outline: 'none',
                    boxSizing: 'border-box',
                  }}
                  onFocus={e => { e.target.style.borderColor = 'var(--blue)' }}
                  onBlur={e => { e.target.style.borderColor = 'var(--border2)' }}
                />
              </div>
            )
          })}
          <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>
            💡 cloudflared 재시작 후 새 URL을 여기에 붙여넣으세요
          </div>
        </div>
      </section>

      {/* ── 상태 수동 설정 ── */}
      <section>
        <SHead>배포 상태 설정</SHead>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>

          {/* GitHub Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11, color: 'var(--t2)', minWidth: 120 }}>GitHub Actions</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {['success', 'running', 'failed'].map(v => (
                <button key={v} onClick={() => setGithubStatus(v)} style={{
                  padding: '4px 10px', borderRadius: 'var(--r)', fontSize: 10, cursor: 'pointer',
                  border: `1px solid ${githubStatus === v ? githubColor : 'var(--border2)'}`,
                  background: githubStatus === v ? `${githubColor}18` : 'transparent',
                  color: githubStatus === v ? githubColor : 'var(--t3)',
                  fontWeight: githubStatus === v ? 700 : 400,
                }}>{v}</button>
              ))}
            </div>
          </div>

          {/* Argo CD Sync */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11, color: 'var(--t2)', minWidth: 120 }}>Argo CD Sync</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {['Synced', 'OutOfSync', 'Unknown'].map(v => {
                const c = v === 'Synced' ? 'var(--green)' : v === 'OutOfSync' ? 'var(--amber)' : 'var(--t3)'
                return (
                  <button key={v} onClick={() => setArgoSync(v)} style={{
                    padding: '4px 10px', borderRadius: 'var(--r)', fontSize: 10, cursor: 'pointer',
                    border: `1px solid ${argoSync === v ? c : 'var(--border2)'}`,
                    background: argoSync === v ? `${c}18` : 'transparent',
                    color: argoSync === v ? c : 'var(--t3)',
                    fontWeight: argoSync === v ? 700 : 400,
                  }}>{v}</button>
                )
              })}
            </div>
          </div>

          {/* Argo CD Health */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11, color: 'var(--t2)', minWidth: 120 }}>Argo CD Health</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {['Healthy', 'Degraded', 'Progressing'].map(v => {
                const c = v === 'Healthy' ? 'var(--green)' : v === 'Degraded' ? 'var(--red)' : 'var(--amber)'
                return (
                  <button key={v} onClick={() => setArgoHealth(v)} style={{
                    padding: '4px 10px', borderRadius: 'var(--r)', fontSize: 10, cursor: 'pointer',
                    border: `1px solid ${argoHealth === v ? c : 'var(--border2)'}`,
                    background: argoHealth === v ? `${c}18` : 'transparent',
                    color: argoHealth === v ? c : 'var(--t3)',
                    fontWeight: argoHealth === v ? 700 : 400,
                  }}>{v}</button>
                )
              })}
            </div>
          </div>

          {/* Pod 상태 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--t2)' }}>Pod 상태</span>
            {services.map(svc => {
              const ps = podStatuses[svc.id] || { status: 'Running', reason: '' }
              const c = ps.status === 'Running' ? 'var(--green)' : ps.status === 'Pending' ? 'var(--amber)' : ps.status === 'Failed' ? 'var(--red)' : 'var(--t3)'
              return (
                <div key={svc.id} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)', minWidth: 100 }}>{svc.name}</span>
                  <div style={{ display: 'flex', gap: 3 }}>
                    {POD_STATUS_OPTIONS.map(v => {
                      const vc = v === 'Running' ? 'var(--green)' : v === 'Pending' ? 'var(--amber)' : v === 'Failed' ? 'var(--red)' : 'var(--t3)'
                      return (
                        <button key={v} onClick={() => setPodStatuses(p => ({ ...p, [svc.id]: { ...ps, status: v, reason: v !== 'Failed' ? '' : ps.reason } })) } style={{
                          padding: '3px 8px', borderRadius: 'var(--r)', fontSize: 10, cursor: 'pointer',
                          border: `1px solid ${ps.status === v ? vc : 'var(--border2)'}`,
                          background: ps.status === v ? `${vc}18` : 'transparent',
                          color: ps.status === v ? vc : 'var(--t3)',
                          fontWeight: ps.status === v ? 700 : 400,
                        }}>{v}</button>
                      )
                    })}
                  </div>
                  {ps.status === 'Failed' && (
                    <select
                      value={ps.reason || ''}
                      onChange={e => setPodStatuses(p => ({ ...p, [svc.id]: { ...ps, reason: e.target.value } }))}
                      style={{
                        background: 'rgba(248,95,109,0.1)', border: '1px solid rgba(248,95,109,0.3)',
                        borderRadius: 'var(--r)', color: 'var(--red)', fontSize: 10, padding: '3px 6px', cursor: 'pointer',
                      }}
                    >
                      <option value="">원인 선택</option>
                      {FAIL_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </section>

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
            <button onClick={stopDemo} style={{
              padding: '4px 12px', borderRadius: 'var(--r)',
              border: '1px solid rgba(248,95,109,0.3)', background: 'transparent',
              color: 'var(--red)', fontSize: 11, cursor: 'pointer',
            }}>중단</button>
          </div>

          {/* ── 상태 카드 5개 ── */}
          <section>
            <SHead>배포 상태</SHead>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
              <StatusCard
                label="GitHub Actions"
                value={githubLabel}
                color={githubColor}
                icon={githubIcon}
              />
              <StatusCard
                label="Argo CD Sync"
                value={argoSync}
                color={argoSync === 'Synced' ? 'var(--green)' : argoSync === 'OutOfSync' ? 'var(--amber)' : 'var(--t3)'}
                icon={argoSync === 'Synced' ? '✓' : '↻'}
              />
              <StatusCard
                label="Argo CD Health"
                value={argoHealth}
                color={argoHealth === 'Healthy' ? 'var(--green)' : argoHealth === 'Degraded' ? 'var(--red)' : 'var(--amber)'}
                icon={argoHealth === 'Healthy' ? '♥' : argoHealth === 'Degraded' ? '✕' : '↻'}
              />
              <StatusCard
                label="Pod Ready"
                value={anyFailed ? 'Failed' : allRunning ? 'All Running' : 'Partial'}
                color={anyFailed ? 'var(--red)' : allRunning ? 'var(--green)' : 'var(--amber)'}
                icon={anyFailed ? '✕' : allRunning ? '✓' : '⚠'}
                subtitle={`${services.filter(s => podStatuses[s.id]?.status === 'Running').length}/${services.length} pods`}
              />
              <StatusCard
                label="외부 URL"
                value={!anyURLSet ? '미설정' : allURLsOk ? 'Reachable' : '확인 중'}
                color={!anyURLSet ? 'var(--t3)' : allURLsOk ? 'var(--green)' : 'var(--amber)'}
                icon={!anyURLSet ? '—' : allURLsOk ? '🌐' : '⚠'}
              />
            </div>
          </section>

          {/* ── 서비스별 외부 URL 표시 ── */}
          <section>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
              <SHead>서비스별 외부 URL</SHead>
              <button onClick={checkAllURLs} style={{
                padding: '3px 10px', borderRadius: 'var(--r)', fontSize: 10, cursor: 'pointer',
                border: '1px solid var(--border2)', background: 'transparent', color: 'var(--t2)',
              }}>↻ 재확인</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {nonDbServices.map(svc => {
                const url = urlMap[svc.id]
                const status = urlStatus[svc.id]
                const kind = classifyService(svc)
                const kindColor = kind === 'frontend' ? 'var(--blue)' : 'var(--purple)'
                const statusColor = status === true ? 'var(--green)' : status === false ? 'var(--red)' : 'var(--t3)'
                const statusLabel = status === true ? '● 접속됨' : status === false ? '● 불가' : '● 미확인'
                return (
                  <div key={svc.id} style={{ padding: '10px 12px', borderRadius: 'var(--r2)', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border2)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: kindColor }}>
                          {kind === 'frontend' ? '🌐 FRONTEND' : '⚙ BACKEND'}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--t2)', fontFamily: 'var(--mono)' }}>{svc.name}</span>
                      </div>
                      <span style={{ fontSize: 10, color: statusColor }}>{statusLabel}</span>
                    </div>
                    {url ? (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--cyan)', flex: 1, wordBreak: 'break-all' }}>{url}</span>
                        <button onClick={() => copyURL(svc.id, url)} style={{
                          padding: '4px 10px', borderRadius: 'var(--r)', fontSize: 10, cursor: 'pointer', flexShrink: 0,
                          border: '1px solid rgba(34,233,160,0.3)', background: 'transparent', color: 'var(--green)',
                        }}>{copied === svc.id ? '✓ 복사됨' : '복사'}</button>
                        <a href={url} target="_blank" rel="noreferrer" style={{
                          padding: '4px 10px', borderRadius: 'var(--r)', fontSize: 10, cursor: 'pointer', flexShrink: 0,
                          border: '1px solid rgba(96,165,250,0.3)', background: 'transparent', color: 'var(--blue)',
                          textDecoration: 'none',
                        }}>열기 ↗</a>
                      </div>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--t3)' }}>URL 미입력 — 위에서 설정해주세요</span>
                    )}
                  </div>
                )
              })}
              {/* DB 서비스는 외부 노출 안 됨 안내 */}
              {services.filter(s => classifyService(s) === 'db').map(svc => (
                <div key={svc.id} style={{ padding: '8px 12px', borderRadius: 'var(--r2)', background: 'rgba(248,95,109,0.04)', border: '1px solid rgba(248,95,109,0.15)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>🗄 {svc.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--red)', opacity: 0.7 }}>🔒 외부 노출 차단</span>
                </div>
              ))}
            </div>
          </section>

          {/* ── Pod 상태 대시보드 ── */}
          <section>
            <SHead>Pod 상태 <span style={{ color: 'var(--t3)', fontWeight: 400 }}>— {services.length} pods</span></SHead>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 90px 80px', gap: 8, padding: '4px 10px', fontSize: 9, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                <span>Name</span><span>Status</span><span>원인</span>
              </div>
              {services.map(svc => {
                const ps = podStatuses[svc.id] || { status: 'Running', reason: '' }
                const statusColor = ps.status === 'Running' ? 'var(--green)' : ps.status === 'Pending' ? 'var(--amber)' : ps.status === 'Failed' ? 'var(--red)' : 'var(--t3)'
                return (
                  <div key={svc.id} style={{ display: 'grid', gridTemplateColumns: '2fr 90px 80px', gap: 8, padding: '6px 10px', borderRadius: 'var(--r)', background: 'rgba(255,255,255,0.02)', alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: 'var(--t1)', fontFamily: 'var(--mono)' }}>{svc.name}</span>
                    <span style={{ fontSize: 10, fontWeight: 600, color: statusColor }}>{ps.status}</span>
                    <span style={{ fontSize: 9, color: 'var(--red)', wordBreak: 'break-word' }}>{ps.reason || '—'}</span>
                  </div>
                )
              })}
            </div>
          </section>

        </>
      )}
    </div>
  )
}
