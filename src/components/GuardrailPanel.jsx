import { ENGINE_META } from '../engines/guardrail'

const SEV = {
  ERROR:   { color:'var(--red)',   bg:'rgba(248,113,113,0.09)', bd:'rgba(248,113,113,0.3)',  icon:'✕' },
  WARNING: { color:'var(--amber)', bg:'rgba(251,191,36,0.08)',  bd:'rgba(251,191,36,0.28)', icon:'⚠' },
}

export default function GuardrailPanel({ result }) {
  if (!result) return <div style={{ color:'var(--t3)', fontSize:13 }}>분석 중...</div>
  const { issues, counts } = result

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:18 }}>

      {/* 요약 */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10 }}>
        {[
          { label:'전체',    value:counts.total,    color:'var(--t2)' },
          { label:'Error',   value:counts.errors,   color:'var(--red)' },
          { label:'Warning', value:counts.warnings, color:'var(--amber)' },
        ].map(({label,value,color})=>(
          <div key={label} style={{
            padding:'14px 10px', textAlign:'center', borderRadius:'var(--r2)',
            background:'rgba(255,255,255,0.03)', border:'1px solid var(--border2)',
          }}>
            <div style={{ fontSize:30, fontWeight:700, color, lineHeight:1 }}>{value}</div>
            <div style={{ fontSize:11, color:'var(--t3)', marginTop:5, letterSpacing:'0.08em', textTransform:'uppercase' }}>{label}</div>
          </div>
        ))}
      </div>

      {/* 엔진별 */}
      <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
        {Object.entries(ENGINE_META).map(([eng,meta])=>{
          const cnt = issues.filter(i=>i.engine===eng).length
          return (
            <span key={eng} style={{
              padding:'4px 10px', borderRadius:5, fontSize:11, fontWeight:600,
              background:`${meta.color}15`, border:`1px solid ${meta.color}30`, color:meta.color,
            }}>
              {eng} · {cnt}
            </span>
          )
        })}
      </div>

      {/* All Clear */}
      {issues.length===0 && (
        <div style={{
          padding:'24px', borderRadius:'var(--r2)', textAlign:'center',
          background:'rgba(74,222,128,0.07)', border:'1px solid rgba(74,222,128,0.3)',
          color:'var(--green)', fontSize:14, fontWeight:600,
        }}>
          ✓ 모든 가드레일 통과 — 배포 가능합니다
        </div>
      )}

      {/* 이슈 목록 */}
      {issues.map(issue=>{
        const cfg  = SEV[issue.severity]||SEV.WARNING
        const eng  = ENGINE_META[issue.engine]||{}
        return (
          <div key={issue.id} style={{
            background:cfg.bg, border:`1px solid ${cfg.bd}`, borderRadius:'var(--r)',
            padding:'12px 14px',
          }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ fontSize:13, color:cfg.color }}>{cfg.icon}</span>
                <span style={{ fontSize:11, color:eng.color, fontWeight:700 }}>{issue.engine}</span>
                <span style={{ fontSize:11, color:'var(--t3)' }}>· {issue.rule}</span>
              </div>
              <span style={{
                fontSize:10, fontWeight:700, letterSpacing:'0.06em',
                color:cfg.color, background:`${cfg.color}18`,
                padding:'2px 7px', borderRadius:3,
              }}>{issue.severity}</span>
            </div>
            <div style={{ fontSize:13, color:'var(--t1)', lineHeight:1.55, marginBottom:5 }}>{issue.message}</div>
            <div style={{ fontSize:12, color:'var(--t3)' }}>→ {issue.suggestion}</div>
          </div>
        )
      })}
    </div>
  )
}
