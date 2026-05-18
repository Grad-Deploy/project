import { useMemo, useState } from 'react'
import { useStore } from './hooks/useStore'
import { SERVICE_TEMPLATES } from './engines/guardrail'
import { buildManifestYAML, genNetworkPolicies, genGitHubActions, genArgoCDApp } from './generators/k8s'
import { buildControlFiles, getPreviewTabs } from './generators/multiUser'
import ServiceCard from './components/ServiceCard'
import GuardrailPanel from './components/GuardrailPanel'
import DeployPanel from './components/DeployPanel'
import MultiUserPanel from './components/MultiUserPanel'
import NetworkTopology from './components/NetworkTopology'
import CreditPanel from './components/CreditPanel'
import DemoMode from './components/DemoMode'
import { Select, Toggle, YamlCode } from './components/Ui'

const LEFT_TABS = [
  { key:'services',  label:'서비스',   icon:'⬡' },
  { key:'guardrail', label:'가드레일', icon:'⊕' },
  { key:'topology',  label:'토폴로지', icon:'◈' },
  { key:'credit',    label:'크레딧',   icon:'◎' },
  { key:'demo',      label:'데모데이', icon:'◉' },
  { key:'deploy',    label:'배포',     icon:'▶' },
  { key:'multi',     label:'멀티유저', icon:'⊗' },
]

const PREVIEW_TABS = [
  { key:'manifest', label:'manifest.yaml', icon:'⬡' },
  { key:'ci',       label:'ci.yml',         icon:'▷' },
  { key:'argo',     label:'argo-app.yaml',  icon:'◈' },
]

const CLOUD_OPTIONS = [
  { value:'local', label:'Minikube / Kind (로컬)' },
  { value:'aws',   label:'AWS EKS' },
  { value:'gcp',   label:'GCP GKE' },
]

export default function App() {
  const { state, engineResult, set, addSvc, delSvc, updSvc, toggleSvc, addMultiUser, delMultiUser, updMultiUser } = useStore()
  const [copied, setCopied] = useState(false)
  const [multiPreviewFile, setMultiPreviewFile] = useState('root-app.yaml')

  const yamlContent = useMemo(() => {
    const manifest = buildManifestYAML(state.services, state.ns)
    const np   = genNetworkPolicies(state.services, state.ns)
    const ci   = genGitHubActions(state.services, { proj:state.proj, ns:state.ns })
    const argo = genArgoCDApp({ proj:state.proj, repo:state.repo, ns:state.ns })
    return { manifest:[manifest,np].join('\n---\n'), ci, argo }
  }, [state.services, state.ns, state.proj, state.repo])

  const multiFiles = useMemo(() =>
    buildControlFiles(state.controlRepo || 'owner/control-repo', state.multiUsers),
    [state.controlRepo, state.multiUsers]
  )
  const multiTabs = useMemo(() =>
    getPreviewTabs(state.multiUsers),
    [state.multiUsers]
  )

  const isMulti   = state.tab === 'multi'
  const activeTabs    = isMulti ? multiTabs : PREVIEW_TABS
  const activeFileKey = isMulti ? multiPreviewFile : state.previewFile
  const preview   = isMulti ? (multiFiles[multiPreviewFile] || '') : (yamlContent[state.previewFile] || '')
  const lineCount = preview.split('\n').length
  const { counts, hasError } = engineResult

  const handleCopy = () => {
    navigator.clipboard?.writeText(preview)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div style={{ height:'100%', display:'flex', flexDirection:'column', overflow:'hidden' }}>

      {/* ══ 헤더 ══════════════════════════════════════ */}
      <header style={{
        height:60, flexShrink:0,
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'0 24px',
        background:'var(--bg2)',
        borderBottom:'2px solid var(--border2)',
        zIndex:50,
      }}>
        {/* 로고 */}
        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          <div style={{
            width:36, height:36, borderRadius:10,
            background:'linear-gradient(135deg,#3b82f6,#1d4ed8)',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontFamily:'var(--sans)', fontWeight:800, fontSize:18, color:'white',
            boxShadow:'0 0 24px rgba(59,130,246,0.45)', flexShrink:0,
          }}>G</div>
          <div>
            <div style={{ fontFamily:'var(--sans)', fontWeight:700, fontSize:17, color:'var(--t1)', letterSpacing:'0.02em' }}>
              GRAD-DEPLOY
            </div>
            <div style={{ fontSize:10, color:'var(--t3)', letterSpacing:'0.1em', marginTop:1 }}>
              POLICY-AS-CODE · K8S GUARDRAIL PLATFORM
            </div>
          </div>
          <span style={{
            fontSize:10, fontWeight:700, color:'var(--blue)',
            background:'rgba(96,165,250,0.12)', border:'1px solid rgba(96,165,250,0.3)',
            padding:'3px 9px', borderRadius:4, marginLeft:4,
          }}>v2.0</span>
        </div>

        {/* 상태 칩 */}
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          {counts.errors > 0 && (
            <SChip color="var(--red)" bg="rgba(248,113,113,0.12)" bd="rgba(248,113,113,0.4)">
              ✕ {counts.errors} Error{counts.errors>1?'s':''}
            </SChip>
          )}
          {counts.warnings > 0 && (
            <SChip color="var(--amber)" bg="rgba(251,191,36,0.12)" bd="rgba(251,191,36,0.4)">
              ⚠ {counts.warnings} Warning{counts.warnings>1?'s':''}
            </SChip>
          )}
          {counts.errors===0 && counts.warnings===0 && (
            <SChip color="var(--green)" bg="rgba(74,222,128,0.1)" bd="rgba(74,222,128,0.3)">
              ✓ All Clear
            </SChip>
          )}
        </div>

        {/* 탭 */}
        <nav style={{ display:'flex', gap:2 }}>
          {LEFT_TABS.map(t => {
            const active = state.tab===t.key
            return (
              <button key={t.key} onClick={()=>set({tab:t.key})} style={{
                display:'flex', alignItems:'center', gap:5,
                padding:'7px 15px', borderRadius:6, border:'none',
                background: active ? 'rgba(96,165,250,0.15)' : 'transparent',
                color: active ? 'var(--blue)' : 'var(--t2)',
                fontSize:12, fontWeight: active?600:400, fontFamily:'var(--mono)',
                cursor:'pointer',
                borderBottom: active ? '2px solid var(--blue)' : '2px solid transparent',
                transition:'all .15s',
              }}
                onMouseEnter={e=>{ if(!active) e.currentTarget.style.color='var(--t1)' }}
                onMouseLeave={e=>{ if(!active) e.currentTarget.style.color='var(--t2)' }}
              >
                <span style={{ fontSize:11, opacity:0.65 }}>{t.icon}</span>
                {t.label}
              </button>
            )
          })}
        </nav>
      </header>

      {/* ══ 바디 ══════════════════════════════════════ */}
      <div style={{ flex:1, display:'flex', overflow:'hidden' }}>

        {/* 좌 패널 */}
        <aside style={{
          width:460, flexShrink:0,
          borderRight:'1px solid var(--border2)',
          display:'flex', flexDirection:'column',
          overflow:'hidden', background:'var(--bg1)',
        }}>
          {/* 프로젝트 설정 */}
          <div style={{
            padding:'16px 20px', borderBottom:'1px solid var(--border2)',
            display:'flex', flexDirection:'column', gap:12,
            background:'var(--bg2)', flexShrink:0,
          }}>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--blue)', letterSpacing:'0.1em', textTransform:'uppercase' }}>
              프로젝트 설정
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              <FInput label="프로젝트명" value={state.proj} onChange={v=>set({proj:v})} placeholder="my-app" />
              <FInput label="Namespace"  value={state.ns}   onChange={v=>set({ns:v})}   placeholder="default" />
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr auto', gap:10, alignItems:'end' }}>
              <Select label="클러스터 환경" value={state.cloud} onChange={v=>set({cloud:v})} options={CLOUD_OPTIONS}/>
              <div style={{ paddingBottom:2 }}>
                <Toggle label="NetworkPolicy" checked={state.netPolicy} onChange={v=>set({netPolicy:v})}/>
              </div>
            </div>
          </div>

          {/* 탭 콘텐츠 — display 토글로 unmount 방지 (state 보존) */}
          <div style={{ flex:1, overflow:'auto', padding:'20px' }}>

            {/* 서비스 탭 */}
            <div style={{ display: state.tab==='services' ? 'flex' : 'none', flexDirection:'column', gap:14 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <span style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>
                  서비스
                  <span style={{ color:'var(--t3)', fontWeight:400, marginLeft:7, fontSize:12 }}>
                    ({state.services.length})
                  </span>
                </span>
                <div style={{ display:'flex', gap:5 }}>
                  {Object.entries(SERVICE_TEMPLATES).map(([k,t])=>(
                    <button key={k} onClick={()=>addSvc(k)} title={`+ ${t.label}`}
                      style={{
                        width:32, height:32, borderRadius:7,
                        background:`${t.color}18`, border:`1px solid ${t.color}35`,
                        color:t.color, fontSize:15, cursor:'pointer',
                        display:'flex', alignItems:'center', justifyContent:'center',
                        transition:'all .15s',
                      }}
                      onMouseEnter={e=>{ e.currentTarget.style.background=`${t.color}30`; e.currentTarget.style.transform='scale(1.1)' }}
                      onMouseLeave={e=>{ e.currentTarget.style.background=`${t.color}18`; e.currentTarget.style.transform='' }}
                    >{t.icon}</button>
                  ))}
                </div>
              </div>

              {state.services.map((svc,idx)=>(
                <div key={svc.id} className="fade-up" style={{ animationDelay:`${idx*0.05}s` }}>
                  <ServiceCard
                    svc={svc} allSvcs={state.services}
                    issues={engineResult.issues.filter(i=>i.message.includes(`[${svc.name}]`))}
                    isOpen={!!state.expandedSvcIds[svc.id]}
                    onToggle={toggleSvc}
                    onUpdate={updSvc} onDelete={delSvc}
                  />
                </div>
              ))}

              {state.services.length===0 && <EmptyState/>}
            </div>

            {/* 가드레일 탭 */}
            {state.tab==='guardrail' && <GuardrailPanel result={engineResult}/>}

            {/* 토폴로지 탭 */}
            {state.tab==='topology' && (
              <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                <NetworkTopology services={state.services} engineIssues={engineResult.issues}/>
                <p style={{ fontSize:12, color:'var(--t2)', lineHeight:1.75 }}>
                  서비스 카드의 <strong style={{ color:'var(--blue)' }}>Depends On</strong> 섹션에서
                  의존성을 설정하면 연결선이 자동으로 그려집니다.
                  순환 의존성은 빨간 점선으로 강조 표시됩니다.
                </p>
              </div>
            )}

            {state.tab==='credit'    && <CreditPanel services={state.services}/>}
            {state.tab==='demo'      && <DemoMode services={state.services} proj={state.proj} ns={state.ns}/>}
            {state.tab==='deploy'    && <DeployPanel state={state} engineResult={engineResult} set={set}/>}
            {state.tab==='multi'     && (
              <MultiUserPanel
                state={state} set={set}
                addMultiUser={addMultiUser}
                delMultiUser={delMultiUser}
                updMultiUser={updMultiUser}
              />
            )}
          </div>
        </aside>

        {/* 우 YAML 프리뷰 */}
        <main style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>

          {/* 파일 탭 바 */}
          <div style={{
            height:46, flexShrink:0,
            display:'flex', alignItems:'center',
            padding:'0 20px', gap:4,
            borderBottom:'1px solid var(--border2)',
            background:'var(--bg2)',
          }}>
            {activeTabs.map(f=>{
              const active = activeFileKey===f.key
              return (
                <button key={f.key} onClick={()=> isMulti ? setMultiPreviewFile(f.key) : set({previewFile:f.key})} style={{
                  display:'flex', alignItems:'center', gap:6,
                  padding:'7px 15px', borderRadius:'6px 6px 0 0', border:'none',
                  background: active ? 'var(--bg0)' : 'transparent',
                  color: active ? 'var(--blue)' : 'var(--t2)',
                  fontSize:12, fontWeight: active?600:400, fontFamily:'var(--mono)',
                  cursor:'pointer',
                  borderBottom: active ? '2px solid var(--blue)' : '2px solid transparent',
                  transition:'all .15s',
                }}
                  onMouseEnter={e=>{ if(!active) e.currentTarget.style.color='var(--t1)' }}
                  onMouseLeave={e=>{ if(!active) e.currentTarget.style.color='var(--t2)' }}
                >
                  <span style={{ fontSize:10, opacity:0.55 }}>{f.icon}</span>
                  {f.label}
                </button>
              )
            })}
            <div style={{ flex:1 }}/>
            <span style={{ fontSize:11, color:'var(--t3)', marginRight:14 }}>
              {lineCount.toLocaleString()} lines
            </span>
            <button onClick={handleCopy} style={{
              padding:'5px 16px', borderRadius:5, fontSize:11, fontWeight:600,
              border:'1px solid var(--border2)',
              background: copied ? 'rgba(74,222,128,0.12)' : 'transparent',
              color: copied ? 'var(--green)' : 'var(--blue)',
              cursor:'pointer', fontFamily:'var(--mono)', transition:'all .2s',
            }}>
              {copied ? '✓ 복사됨' : 'Copy'}
            </button>
          </div>

          {/* 코드 뷰 */}
          <div style={{ flex:1, overflow:'auto', background:'#050810', padding:'22px 26px' }}>
            <div style={{ display:'flex', gap:0 }}>
              {/* 줄 번호 */}
              <div style={{
                flexShrink:0, userSelect:'none', textAlign:'right',
                minWidth:44, paddingRight:16, marginRight:16,
                borderRight:'1px solid #1e293b',
                color:'#334155', fontSize:14, lineHeight:1.65, fontFamily:'var(--mono)',
              }}>
                {preview.split('\n').map((_,i)=><div key={i}>{i+1}</div>)}
              </div>
              {/* 코드 */}
              <pre style={{
                margin:0, flex:1,
                fontSize:15, lineHeight:1.65,
                whiteSpace:'pre-wrap', wordBreak:'break-word',
                fontFamily:'var(--mono)',
              }}>
                <YamlCode code={preview}/>
              </pre>
            </div>
          </div>

          {/* 상태바 */}
          <div style={{
            height:32, flexShrink:0,
            display:'flex', alignItems:'center',
            padding:'0 20px', gap:22,
            borderTop:'1px solid var(--border2)',
            background:'var(--bg2)',
          }}>
            <SPill label="ns"       value={state.ns}/>
            <SPill label="services" value={state.services.length}/>
            <SPill label="env"      value={state.cloud}/>
            <SPill
              label="issues"
              value={`${counts.errors}E · ${counts.warnings}W`}
              color={counts.errors>0 ? 'var(--red)' : counts.warnings>0 ? 'var(--amber)' : 'var(--t3)'}
            />
            <div style={{ flex:1 }}/>
            <span style={{ fontSize:11, fontWeight:700, color: hasError?'var(--red)':'var(--green)' }}>
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
      padding:'4px 12px', borderRadius:5, fontSize:12, fontWeight:600,
      background:bg, border:`1px solid ${bd}`, color,
    }}>{children}</span>
  )
}

function SPill({ label, value, color }) {
  return (
    <span style={{ fontSize:11 }}>
      <span style={{ color:'var(--t3)' }}>{label}: </span>
      <span style={{ color:color||'var(--t2)', fontWeight:600 }}>{value}</span>
    </span>
  )
}

function FInput({ label, value, onChange, placeholder }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
      <span style={{ fontSize:11, fontWeight:600, color:'var(--t2)', letterSpacing:'0.06em', textTransform:'uppercase' }}>{label}</span>
      <input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
        style={{
          background:'rgba(255,255,255,0.06)', border:'1px solid var(--border2)',
          borderRadius:'var(--r)', color:'var(--t1)', padding:'8px 12px',
          fontSize:13, fontFamily:'var(--mono)', width:'100%', outline:'none',
          transition:'border-color .15s, background .15s',
        }}
        onFocus={e=>{ e.target.style.borderColor='var(--blue)'; e.target.style.background='rgba(96,165,250,0.07)' }}
        onBlur={e=>{  e.target.style.borderColor='var(--border2)'; e.target.style.background='rgba(255,255,255,0.06)' }}
      />
    </div>
  )
}

function EmptyState() {
  return (
    <div style={{
      padding:'56px 24px', textAlign:'center',
      border:'1px dashed var(--border2)', borderRadius:'var(--r2)',
    }}>
      <div style={{ fontSize:40, marginBottom:16, opacity:0.3 }}>⬡</div>
      <div style={{ fontSize:15, fontWeight:600, color:'var(--t2)', marginBottom:8 }}>서비스가 없습니다</div>
      <div style={{ fontSize:12, color:'var(--t3)', lineHeight:1.7 }}>위의 아이콘 버튼으로 서비스를 추가하세요</div>
    </div>
  )
}
