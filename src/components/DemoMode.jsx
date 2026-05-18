import { useState, useEffect, useRef } from 'react'

// ── slug 생성 ──────────────────────────────────────────────
function makeSlug(proj) {
  const rand = Math.random().toString(36).slice(2, 7)
  return `${proj.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${rand}`
}

// ── 상태 시뮬레이터 (실제 클러스터 연결 전 AI 시뮬레이션) ─
function simulatePodStatus(services) {
  return services.map(svc => ({
    name: svc.name,
    type: svc.type,
    replicas: parseInt(svc.replicas) || 1,
    ready: parseInt(svc.replicas) || 1,
    status: Math.random() > 0.1 ? 'Running' : 'Pending',
    restarts: Math.floor(Math.random() * 3),
    age: `${Math.floor(Math.random() * 60 + 1)}m`,
    cpu: `${(Math.random() * 80 + 5).toFixed(0)}m`,
    mem: `${(Math.random() * 400 + 50).toFixed(0)}Mi`,
  }))
}

// ── 업타임 포맷 ────────────────────────────────────────────
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${h}h ${m}m ${s}s`
}

// ── LIVE 인디케이터 ─────────────────────────────────────────
function LiveDot() {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: 'var(--green)',
        display: 'inline-block',
        animation: 'pulse 1.4s ease-in-out infinite',
      }} />
      <span style={{
        position: 'absolute', top: 0, left: 0,
        width: 8, height: 8, borderRadius: '50%',
        background: 'var(--green)',
        opacity: 0.4,
        animation: 'pulse 1.4s ease-in-out infinite',
        transform: 'scale(2)',
      }} />
    </span>
  )
}

export default function DemoMode({ services, proj, ns }) {
  const [active, setActive] = useState(false)
  const [slug, setSlug] = useState('')
  const [pods, setPods] = useState([])
  const [uptime, setUptime] = useState(0)
  const [copied, setCopied] = useState(false)
  const [argoStatus, setArgoStatus] = useState('Synced')
  const timerRef = useRef(null)

  const demoURL = slug ? `https://${slug}.grad-deploy.demo` : ''

  // 데모 시작
  const startDemo = () => {
    const s = makeSlug(proj || 'my-app')
    setSlug(s)
    setUptime(0)
    setPods(simulatePodStatus(services))
    setActive(true)
  }

  // 데모 중단
  const stopDemo = () => {
    setActive(false)
    clearInterval(timerRef.current)
  }

  // 실시간 갱신 (5초마다)
  useEffect(() => {
    if (!active) return
    timerRef.current = setInterval(() => {
      setUptime(u => u + 5)
      setPods(simulatePodStatus(services))
      // Argo CD 상태 랜덤 시뮬레이션
      setArgoStatus(Math.random() > 0.05 ? 'Synced' : 'OutOfSync')
    }, 5000)
    return () => clearInterval(timerRef.current)
  }, [active, services])

  const copyURL = () => {
    navigator.clipboard?.writeText(demoURL)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const allRunning = pods.every(p => p.status === 'Running')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* 헤더 */}
      {!active ? (
        <div style={{
          padding: '24px',
          border: '1px dashed var(--border)',
          borderRadius: 'var(--r2)',
          textAlign: 'center',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
        }}>
          <div style={{ fontSize: 36 }}>🎓</div>
          <div style={{ fontSize: 14, color: 'var(--t1)', fontWeight: 600 }}>
            데모데이 모드
          </div>
          <div style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.6, maxWidth: 300 }}>
            심사위원이 외부에서 접속할 수 있는 공개 URL을 생성하고
            실시간 배포 상태를 대시보드로 공유합니다.
          </div>
          <button
            onClick={startDemo}
            style={{
              marginTop: 4,
              padding: '10px 28px', borderRadius: 'var(--r)',
              background: 'linear-gradient(135deg, #529cff, #1d4ed8)',
              border: 'none', color: 'white',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
              fontFamily: 'var(--mono)',
              boxShadow: '0 4px 20px rgba(82,156,255,0.3)',
            }}
          >
            🚀 데모 시작
          </button>
        </div>
      ) : (
        <>
          {/* 공개 URL */}
          <div style={{
            padding: '14px 16px', borderRadius: 'var(--r2)',
            background: 'rgba(34,233,160,0.07)',
            border: '1px solid rgba(34,233,160,0.3)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <LiveDot />
                <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 600, marginLeft: 8 }}>LIVE</span>
              </div>
              <span style={{ fontSize: 10, color: 'var(--t3)' }}>
                업타임: {formatUptime(uptime)}
              </span>
            </div>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 12,
              color: 'var(--cyan)', marginBottom: 8,
              wordBreak: 'break-all',
            }}>
              {demoURL}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={copyURL} style={{
                padding: '5px 14px', borderRadius: 'var(--r)',
                border: '1px solid rgba(34,233,160,0.3)',
                background: 'transparent', color: 'var(--green)',
                fontSize: 11, cursor: 'pointer', fontFamily: 'var(--mono)',
              }}>
                {copied ? '✓ 복사됨' : '클립보드 복사'}
              </button>
              <button onClick={stopDemo} style={{
                padding: '5px 14px', borderRadius: 'var(--r)',
                border: '1px solid rgba(248,95,109,0.3)',
                background: 'transparent', color: 'var(--red)',
                fontSize: 11, cursor: 'pointer', fontFamily: 'var(--mono)',
              }}>
                중단
              </button>
            </div>
          </div>

          {/* Argo CD 상태 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <StatusCard
              label="Argo CD"
              value={argoStatus}
              color={argoStatus === 'Synced' ? 'var(--green)' : 'var(--amber)'}
              icon={argoStatus === 'Synced' ? '✓' : '↻'}
            />
            <StatusCard
              label="전체 상태"
              value={allRunning ? 'Healthy' : 'Degraded'}
              color={allRunning ? 'var(--green)' : 'var(--amber)'}
              icon={allRunning ? '✓' : '⚠'}
            />
          </div>

          {/* Pod 목록 */}
          <section>
            <SHead>Pod 상태 <span style={{ color: 'var(--t3)', fontWeight: 400 }}>— {pods.length} pods</span></SHead>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 8 }}>
              {/* 헤더 행 */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '2fr 80px 60px 60px 50px 50px',
                gap: 8, padding: '4px 10px',
                fontSize: 9, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase',
              }}>
                <span>Name</span>
                <span>Status</span>
                <span>Ready</span>
                <span>Restarts</span>
                <span>CPU</span>
                <span>Mem</span>
              </div>

              {pods.map(pod => (
                <div key={pod.name} style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 80px 60px 60px 50px 50px',
                  gap: 8, padding: '6px 10px',
                  borderRadius: 'var(--r)',
                  background: 'rgba(255,255,255,0.02)',
                  alignItems: 'center',
                }}>
                  <span style={{ fontSize: 11, color: 'var(--t1)', fontFamily: 'var(--mono)' }}>{pod.name}</span>
                  <span style={{
                    fontSize: 10, fontWeight: 600,
                    color: pod.status === 'Running' ? 'var(--green)' : 'var(--amber)',
                  }}>{pod.status}</span>
                  <span style={{ fontSize: 10, color: 'var(--t2)' }}>{pod.ready}/{pod.replicas}</span>
                  <span style={{ fontSize: 10, color: pod.restarts > 0 ? 'var(--amber)' : 'var(--t3)' }}>{pod.restarts}</span>
                  <span style={{ fontSize: 10, color: 'var(--blue)', fontFamily: 'var(--mono)' }}>{pod.cpu}</span>
                  <span style={{ fontSize: 10, color: 'var(--purple)', fontFamily: 'var(--mono)' }}>{pod.mem}</span>
                </div>
              ))}
            </div>
          </section>

          {/* 아키텍처 요약 */}
          <section>
            <SHead>배포 아키텍처</SHead>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {pods.map(pod => (
                <div key={pod.name} style={{
                  padding: '6px 10px', borderRadius: 'var(--r)',
                  background: 'rgba(255,255,255,0.03)',
                  border: `1px solid ${pod.status === 'Running' ? 'rgba(34,233,160,0.25)' : 'rgba(255,181,71,0.25)'}`,
                  fontSize: 10, color: 'var(--t2)',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: pod.status === 'Running' ? 'var(--green)' : 'var(--amber)',
                    flexShrink: 0,
                    animation: pod.status === 'Running' ? 'pulse 2s ease-in-out infinite' : 'none',
                  }} />
                  {pod.name}
                </div>
              ))}
            </div>
          </section>

          <div style={{ fontSize: 10, color: 'var(--t3)', textAlign: 'center' }}>
            ↻ 5초마다 자동 갱신 · AI 시뮬레이션 모드
            <br />
            실제 클러스터 연동은 백엔드 연결 후 활성화됩니다
          </div>
        </>
      )}
    </div>
  )
}

function StatusCard({ label, value, color, icon }) {
  return (
    <div style={{
      padding: '12px', borderRadius: 'var(--r2)',
      background: `${color}08`,
      border: `1px solid ${color}28`,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      <div>
        <div style={{ fontSize: 9, color: 'var(--t3)', marginBottom: 3, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</div>
        <div style={{ fontSize: 13, fontWeight: 700, color }}>{value}</div>
      </div>
      <div style={{ fontSize: 22, color, opacity: 0.7 }}>{icon}</div>
    </div>
  )
}

function SHead({ children }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, color: 'var(--blue)',
      letterSpacing: '0.12em', textTransform: 'uppercase',
      paddingBottom: 6, borderBottom: '1px solid var(--border)',
    }}>{children}</div>
  )
}
