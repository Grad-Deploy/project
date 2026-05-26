import { useMemo, useState } from 'react'
import { useStore } from './hooks/useStore_improved'
import { SERVICE_TEMPLATES } from './engines/guardrail'
import { buildManifestYAML, genNetworkPolicies, genGitHubActions, genArgoCDApp, genArgoCDAdminConfig } from './generators/k8s_improved'
import ServiceCard from './components/ServiceCard_integrated'
import GuardrailPanel from './components/GuardrailPanel'
import DeployPanel from './components/DeployPanel'
import NetworkTopology from './components/NetworkTopology'
import ClusterAdvisorPanel from './components/ClusterAdvisorPanel'
import CreditPanel from './components/CreditPanel'
import DemoMode from './components/DemoMode'
import { Select, Toggle, YamlCode } from './components/Ui'

const LEFT_TABS = [
  { key: 'services', label: '서비스', icon: '⬡' },
  { key: 'guardrail', label: '가드레일', icon: '⊕' },
  { key: 'topology', label: '토폴로지', icon: '◈' },
  { key: 'advisor', label: '클러스터', icon: '💻' },
  { key: 'credit', label: '크레딧', icon: '◎' },
  { key: 'demo', label: '데모데이', icon: '◉' },
  { key: 'deploy', label: '배포', icon: '▶' },
]

const PREVIEW_TABS = [
  { key: 'manifest', label: 'manifest.yaml',  icon: '⬡' },
  { key: 'ci',       label: 'ci.yml',          icon: '▷' },
  { key: 'argo',     label: 'argo-app.yaml',   icon: '◈' },
  { key: 'sso',      label: 'argocd-cm.yaml',  icon: '◉' },  // SSO 설정 실시간 미리보기
]

const CLOUD_OPTIONS = [
  { value: 'kind',  label: 'kind (로컬 멀티 노드) — 권장' },
  { value: 'local', label: 'Minikube (로컬 단일 노드)' },
  { value: 'aws',   label: 'AWS EKS' },
  { value: 'gcp',   label: 'GCP GKE' },
]

export default function App() {
  const { state, engineResult, propagatedServices, envIssues, resourceWarnings, set, addSvc, delSvc, updSvc, toggleSvc } = useStore()
  const [copied, setCopied] = useState(false)

  const yamlContent = useMemo(() => {
    const manifest = buildManifestYAML(state.services, state.ns, state.cloud)
    const np = genNetworkPolicies(state.services, state.ns)
    const ci = genGitHubActions(state.services, {
      proj: state.proj,
      ns: state.ns,
      registry: state.registry,
      dockerhubUser: state.dockerhubUser,
      cloud: state.cloud,   // kind/local → 로컬 레지스트리 분기, kind-config.yaml 경로 등에 사용
    })
    const argo = genArgoCDApp({
      proj: state.proj,
      // 미입력 상태에서도 의미 있는 플레이스홀더를 YAML 미리보기에 표시
      repo: state.repo || 'https://github.com/YOUR_ORG/YOUR_REPO',
      ns: state.ns,
    })
    // SSO 설정 탭에서 입력한 값을 반영한 argocd-cm 미리보기
    // SsoSetupSection에서 set()으로 저장한 state 값을 그대로 사용
    const adminConfig = genArgoCDAdminConfig({
      proj:          state.proj,
      ns:            state.ns,
      githubClientId: state.ssoClientId  || 'REPLACE_WITH_OAUTH_CLIENT_ID',
      argocdServer:  state.argocdServer  || 'argocd.example.com',
      ssoTeams:      state.ssoTeams      || [],
    })
    return {
      manifest: [manifest, np].join('\n---\n'),
      ci,
      argo,
      // argocd-cm / argocd-rbac-cm 을 합쳐서 미리보기 (실제 파일은 분리 저장됨)
      sso: [adminConfig.cm, adminConfig.rbac].join('\n---\n'),
    }
  }, [
    state.services, state.ns, state.proj, state.repo, state.cloud,
    state.registry, state.dockerhubUser,
    // SSO 관련 의존성 — 입력할 때마다 미리보기 실시간 갱신
    state.ssoClientId, state.argocdServer, state.ssoTeams,
  ])

  const preview = yamlContent[state.previewFile] || ''
  const lineCount = preview.split('\n').length
  const { counts, hasError } = engineResult

  const handleCopy = () => {
    navigator.clipboard?.writeText(preview)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ══ 헤더 ══════════════════════════════════════ */}
      <header style={{
        height: 60, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 24px',
        background: 'var(--bg2)',
        borderBottom: '2px solid var(--border2)',
        zIndex: 50,
      }}>
        {/* 로고 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'linear-gradient(135deg,#3b82f6,#1d4ed8)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--sans)', fontWeight: 800, fontSize: 18, color: 'white',
            boxShadow: '0 0 24px rgba(59,130,246,0.45)', flexShrink: 0,
          }}>G</div>
          <div>
            <div style={{ fontFamily: 'var(--sans)', fontWeight: 700, fontSize: 17, color: 'var(--t1)', letterSpacing: '0.02em' }}>
              GRAD-DEPLOY
            </div>
            <div style={{ fontSize: 10, color: 'var(--t3)', letterSpacing: '0.1em', marginTop: 1 }}>
              POLICY-AS-CODE · K8S GUARDRAIL PLATFORM
            </div>
          </div>
          <span style={{
            fontSize: 10, fontWeight: 700, color: 'var(--blue)',
            background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.3)',
            padding: '3px 9px', borderRadius: 4, marginLeft: 4,
          }}>v2.0</span>
        </div>

        {/* 상태 칩 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {counts.errors > 0 && (
            <SChip color="var(--red)" bg="rgba(248,113,113,0.12)" bd="rgba(248,113,113,0.4)">
              ✕ {counts.errors} Error{counts.errors > 1 ? 's' : ''}
            </SChip>
          )}
          {counts.warnings > 0 && (
            <SChip color="var(--amber)" bg="rgba(251,191,36,0.12)" bd="rgba(251,191,36,0.4)">
              ⚠ {counts.warnings} Warning{counts.warnings > 1 ? 's' : ''}
            </SChip>
          )}
          {counts.errors === 0 && counts.warnings === 0 && (
            <SChip color="var(--green)" bg="rgba(74,222,128,0.1)" bd="rgba(74,222,128,0.3)">
              ✓ All Clear
            </SChip>
          )}
        </div>

        {/* 탭 */}
        <nav style={{ display: 'flex', gap: 2 }}>
          {LEFT_TABS.map(t => {
            const active = state.tab === t.key
            return (
              <button key={t.key} onClick={() => set({ tab: t.key })} style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '7px 15px', borderRadius: 6, border: 'none',
                background: active ? 'rgba(96,165,250,0.15)' : 'transparent',
                color: active ? 'var(--blue)' : 'var(--t2)',
                fontSize: 12, fontWeight: active ? 600 : 400, fontFamily: 'var(--mono)',
                cursor: 'pointer',
                borderBottom: active ? '2px solid var(--blue)' : '2px solid transparent',
                transition: 'all .15s',
              }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.color = 'var(--t1)' }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.color = 'var(--t2)' }}
              >
                <span style={{ fontSize: 11, opacity: 0.65 }}>{t.icon}</span>
                {t.label}
              </button>
            )
          })}
        </nav>
      </header>

      {/* ══ 바디 ══════════════════════════════════════ */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* 좌 패널 */}
        <aside style={{
          width: 460, flexShrink: 0,
          borderRight: '1px solid var(--border2)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden', background: 'var(--bg1)',
        }}>
          {/* 프로젝트 설정 */}
          <div style={{
            padding: '16px 20px', borderBottom: '1px solid var(--border2)',
            display: 'flex', flexDirection: 'column', gap: 12,
            background: 'var(--bg2)', flexShrink: 0,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              프로젝트 설정
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <FInput label="프로젝트명" value={state.proj} onChange={v => set({ proj: v })} placeholder="my-app" />
              <FInput label="Namespace" value={state.ns} onChange={v => set({ ns: v })} placeholder="default" />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'end' }}>
              <Select label="클러스터 환경" value={state.cloud} onChange={v => set({ cloud: v })} options={CLOUD_OPTIONS} />
              <div style={{ paddingBottom: 2 }}>
                <Toggle label="NetworkPolicy" checked={state.netPolicy} onChange={v => set({ netPolicy: v })} />
              </div>
            </div>

            {/* kind 전용 설정 */}
            {(state.cloud === 'kind') && (
              <div style={{
                padding: '10px 14px',
                borderRadius: 'var(--r)',
                background: 'rgba(96,165,250,0.05)',
                border: '1px solid rgba(96,165,250,0.2)',
                display: 'flex', flexDirection: 'column', gap: 10,
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--blue)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                  kind 클러스터 설정
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignItems: 'end' }}>
                  <FInput
                    label="Worker 노드 수"
                    value={state.kindWorkerCount}
                    onChange={v => set({ kindWorkerCount: Math.max(1, parseInt(v) || 2) })}
                    placeholder="2"
                  />
                  <FInput
                    label="로컬 레지스트리 포트"
                    value={state.kindRegistryPort}
                    onChange={v => set({ kindRegistryPort: parseInt(v) || 5001 })}
                    placeholder="5001"
                  />
                </div>
                <Toggle
                  label="로컬 레지스트리 연동 (CI 없이 이미지 직접 Push)"
                  checked={state.kindUseLocalRegistry}
                  onChange={v => set({ kindUseLocalRegistry: v })}
                />
                <div style={{ fontSize: 10, color: 'var(--t3)', lineHeight: 1.6 }}>
                  배포 시 <code style={{ color: 'var(--cyan)' }}>kind-config.yaml</code>과
                  {state.kindUseLocalRegistry && <> <code style={{ color: 'var(--cyan)' }}>scripts/setup-kind-registry.sh</code>가</>}
                  {' '}자동 생성됩니다.
                </div>
              </div>
            )}
          </div>

          {/* 탭 콘텐츠 — display 토글로 unmount 방지 (state 보존) */}
          <div style={{ flex: 1, overflow: 'auto', padding: '20px' }}>

            {/* 서비스 탭 */}
            <div style={{ display: state.tab === 'services' ? 'flex' : 'none', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  서비스
                  <span style={{ color: 'var(--t3)', fontWeight: 400, marginLeft: 7, fontSize: 12 }}>
                    ({state.services.length})
                  </span>
                </span>
                <div style={{ display: 'flex', gap: 5 }}>
                  {Object.entries(SERVICE_TEMPLATES).map(([k, t]) => (
                    <button key={k} onClick={() => addSvc(k)} title={`+ ${t.label}`}
                      style={{
                        width: 32, height: 32, borderRadius: 7,
                        background: `${t.color}18`, border: `1px solid ${t.color}35`,
                        color: t.color, fontSize: 15, cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'all .15s',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = `${t.color}30`; e.currentTarget.style.transform = 'scale(1.1)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = `${t.color}18`; e.currentTarget.style.transform = '' }}
                    >{t.icon}</button>
                  ))}
                </div>
              </div>

              {state.services.map((svc, idx) => (
                <div key={svc.id} className="fade-up" style={{ animationDelay: `${idx * 0.05}s` }}>
                  <ServiceCard
                    svc={svc} allServices={propagatedServices}
                    nginxCount={state.services.filter(s => s.type === 'nginx' || s.type === 'react-nginx').length}
                    others={state.services.map(s => s.name).filter(n => n !== svc.name)}
                    resourceWarnings={resourceWarnings}
                    issues={[
                      // guardrail 엔진 이슈 (severity: 'ERROR'/'WARNING', 대문자)
                      ...engineResult.issues.filter(i => i.message.includes(`[${svc.name}]`)),
                      // envManager 검증 이슈 (severity: 'error'/'warning', 소문자) — 포맷 통일
                      ...envIssues
                        .filter(i => i.svcName === svc.name)
                        .map(i => ({
                          id:         `env-${i.svcName}-${i.key}`,
                          engine:     'VE',
                          severity:   i.severity.toUpperCase(),  // 대문자로 통일
                          rule:       'VE-env',
                          message:    i.message,
                          suggestion: i.suggestion,
                          field:      i.key,
                        })),
                    ]}
                    open={!!state.expandedSvcIds[svc.id]}
                    onToggle={() => toggleSvc(svc.id)}
                    upd={patch => updSvc(svc.id, patch)} del={() => delSvc(svc.id)}
                  />
                </div>
              ))}

              {state.services.length === 0 && <EmptyState />}
            </div>

            {/* 가드레일 탭 */}
            {state.tab === 'guardrail' && <GuardrailPanel result={engineResult} />}

            {/* 토폴로지 탭 */}
            {state.tab === 'topology' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <NetworkTopology services={state.services} engineIssues={engineResult.issues} />
                <p style={{ fontSize: 12, color: 'var(--t2)', lineHeight: 1.75 }}>
                  서비스 카드의 <strong style={{ color: 'var(--blue)' }}>Depends On</strong> 섹션에서
                  의존성을 설정하면 연결선이 자동으로 그려집니다.
                  순환 의존성은 빨간 점선으로 강조 표시됩니다.
                </p>
              </div>
            )}

            {/* 클러스터 탭 */}
            <div style={{ display: state.tab === 'advisor' ? 'block' : 'none' }}>
              <ClusterAdvisorPanel 
                onCapacityChange={({ availableCPU, availableMem }) => set({ caAvailableCPU: availableCPU, caAvailableMem: availableMem })}
                onRunRA={() => set({ tab: 'guardrail' })}
              />
            </div>

            {state.tab === 'credit' && <CreditPanel services={state.services} availableCPU={state.caAvailableCPU} availableMem={state.caAvailableMem} />}
            {state.tab === 'demo' && <DemoMode services={state.services} proj={state.proj} ns={state.ns} />}
            {state.tab === 'deploy' && <DeployPanel state={state} engineResult={engineResult} set={set} />}
          </div>
        </aside>

        {/* 우 YAML 프리뷰 */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* 파일 탭 바 */}
          <div style={{
            height: 46, flexShrink: 0,
            display: 'flex', alignItems: 'center',
            padding: '0 20px', gap: 4,
            borderBottom: '1px solid var(--border2)',
            background: 'var(--bg2)',
          }}>
            {PREVIEW_TABS.map(f => {
              const active = state.previewFile === f.key
              return (
                <button key={f.key} onClick={() => set({ previewFile: f.key })} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '7px 15px', borderRadius: '6px 6px 0 0', border: 'none',
                  background: active ? 'var(--bg0)' : 'transparent',
                  color: active ? 'var(--blue)' : 'var(--t2)',
                  fontSize: 12, fontWeight: active ? 600 : 400, fontFamily: 'var(--mono)',
                  cursor: 'pointer',
                  borderBottom: active ? '2px solid var(--blue)' : '2px solid transparent',
                  transition: 'all .15s',
                }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.color = 'var(--t1)' }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.color = 'var(--t2)' }}
                >
                  <span style={{ fontSize: 10, opacity: 0.55 }}>{f.icon}</span>
                  {f.label}
                </button>
              )
            })}
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: 'var(--t3)', marginRight: 14 }}>
              {lineCount.toLocaleString()} lines
            </span>
            <button onClick={handleCopy} style={{
              padding: '5px 16px', borderRadius: 5, fontSize: 11, fontWeight: 600,
              border: '1px solid var(--border2)',
              background: copied ? 'rgba(74,222,128,0.12)' : 'transparent',
              color: copied ? 'var(--green)' : 'var(--blue)',
              cursor: 'pointer', fontFamily: 'var(--mono)', transition: 'all .2s',
            }}>
              {copied ? '✓ 복사됨' : 'Copy'}
            </button>
          </div>

          {/* 코드 뷰 */}
          <div style={{ flex: 1, overflow: 'auto', background: '#050810', padding: '22px 26px' }}>
            <div style={{ display: 'flex', gap: 0 }}>
              {/* 줄 번호 */}
              <div style={{
                flexShrink: 0, userSelect: 'none', textAlign: 'right',
                minWidth: 44, paddingRight: 16, marginRight: 16,
                borderRight: '1px solid #1e293b',
                color: '#334155', fontSize: 14, lineHeight: 1.65, fontFamily: 'var(--mono)',
              }}>
                {preview.split('\n').map((_, i) => <div key={i}>{i + 1}</div>)}
              </div>
              {/* 코드 */}
              <pre style={{
                margin: 0, flex: 1,
                fontSize: 15, lineHeight: 1.65,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                fontFamily: 'var(--mono)',
              }}>
                <YamlCode code={preview} />
              </pre>
            </div>
          </div>

          {/* 상태바 */}
          <div style={{
            height: 32, flexShrink: 0,
            display: 'flex', alignItems: 'center',
            padding: '0 20px', gap: 22,
            borderTop: '1px solid var(--border2)',
            background: 'var(--bg2)',
          }}>
            <SPill label="ns" value={state.ns} />
            <SPill label="services" value={state.services.length} />
            <SPill label="env" value={state.cloud} />
            <SPill
              label="issues"
              value={`${counts.errors}E · ${counts.warnings}W`}
              color={counts.errors > 0 ? 'var(--red)' : counts.warnings > 0 ? 'var(--amber)' : 'var(--t3)'}
            />
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, fontWeight: 700, color: hasError ? 'var(--red)' : 'var(--green)' }}>
              {hasError ? '✕  배포 불가' : '✓  배포 가능'}
            </span>
          </div>
        </main>
      </div>
    </div>
  )
}

// ── 헬퍼 컴포넌트 ─────────────────────────────────────────

function SChip({ children, color, bg, bd }) {
  return (
    <span style={{
      padding: '4px 12px', borderRadius: 5, fontSize: 12, fontWeight: 600,
      background: bg, border: `1px solid ${bd}`, color,
    }}>{children}</span>
  )
}

function SPill({ label, value, color }) {
  return (
    <span style={{ fontSize: 11 }}>
      <span style={{ color: 'var(--t3)' }}>{label}: </span>
      <span style={{ color: color || 'var(--t2)', fontWeight: 600 }}>{value}</span>
    </span>
  )
}

function FInput({ label, value, onChange, placeholder }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--t2)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</span>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{
          background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border2)',
          borderRadius: 'var(--r)', color: 'var(--t1)', padding: '8px 12px',
          fontSize: 13, fontFamily: 'var(--mono)', width: '100%', outline: 'none',
          transition: 'border-color .15s, background .15s',
        }}
        onFocus={e => { e.target.style.borderColor = 'var(--blue)'; e.target.style.background = 'rgba(96,165,250,0.07)' }}
        onBlur={e => { e.target.style.borderColor = 'var(--border2)'; e.target.style.background = 'rgba(255,255,255,0.06)' }}
      />
    </div>
  )
}

function EmptyState() {
  return (
    <div style={{
      padding: '56px 24px', textAlign: 'center',
      border: '1px dashed var(--border2)', borderRadius: 'var(--r2)',
    }}>
      <div style={{ fontSize: 40, marginBottom: 16, opacity: 0.3 }}>⬡</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--t2)', marginBottom: 8 }}>서비스가 없습니다</div>
      <div style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.7 }}>위의 아이콘 버튼으로 서비스를 추가하세요</div>
    </div>
  )
}
