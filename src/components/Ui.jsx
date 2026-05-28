// ── 원자 UI 컴포넌트 ─────────────────────────────────────────

const baseInput = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid var(--border2)',
  borderRadius: 'var(--r)',
  color: 'var(--t1)',
  padding: '8px 12px',
  width: '100%',
  outline: 'none',
  fontSize: 13,
  lineHeight: 1.5,
  transition: 'border-color .15s, background .15s',
}

export function Input({ label, value, onChange, placeholder, type='text', secret=false, hint }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
      {label && <span style={{ fontSize:11, fontWeight:600, color:'var(--t2)', letterSpacing:'0.06em', textTransform:'uppercase' }}>{label}</span>}
      <input
        type={secret?'password':type}
        value={value??''}
        onChange={e=>onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={secret?'off':undefined}
        style={baseInput}
        onFocus={e=>{e.target.style.borderColor='var(--blue)';e.target.style.background='rgba(96,165,250,0.07)'}}
        onBlur={e=>{e.target.style.borderColor='var(--border2)';e.target.style.background='rgba(255,255,255,0.06)'}}
      />
      {hint && <span style={{ fontSize:11, color:'var(--t3)', lineHeight:1.5 }}>{hint}</span>}
    </div>
  )
}

export function Select({ label, value, onChange, options }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
      {label && <span style={{ fontSize:11, fontWeight:600, color:'var(--t2)', letterSpacing:'0.06em', textTransform:'uppercase' }}>{label}</span>}
      <select value={value} onChange={e=>onChange(e.target.value)}
        style={{...baseInput, background:'var(--bg3)', cursor:'pointer', appearance:'none',
          backgroundImage:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2394a3b8'/%3E%3C/svg%3E")`,
          backgroundRepeat:'no-repeat', backgroundPosition:'right 12px center', paddingRight:32}}>
        {options.map(o=><option key={o.value} value={o.value} style={{background:'var(--bg2)'}}>{o.label}</option>)}
      </select>
    </div>
  )
}

export function Toggle({ label, checked, onChange }) {
  return (
    <label style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer', userSelect:'none' }}>
      <span onClick={()=>onChange(!checked)} style={{
        width:36, height:20, borderRadius:10,
        background: checked ? 'var(--blue)' : 'rgba(255,255,255,0.12)',
        position:'relative', flexShrink:0,
        transition:'background .2s',
        border:'1px solid '+(checked?'var(--blue)':'var(--border2)'),
        display:'block',
      }}>
        <span style={{
          position:'absolute', top:'50%', transform:'translateY(-50%)',
          left: checked ? 18 : 3,
          width:14, height:14, borderRadius:'50%',
          background:'white', transition:'left .2s',
          boxShadow:'0 1px 4px rgba(0,0,0,0.4)',
        }}/>
      </span>
      {label && <span style={{ fontSize:12, color: checked?'var(--t1)':'var(--t2)' }}>{label}</span>}
    </label>
  )
}

export function SectionTitle({ children, action }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', paddingBottom:10, borderBottom:'1px solid var(--border2)' }}>
      <span style={{ fontSize:11, fontWeight:700, letterSpacing:'0.1em', textTransform:'uppercase', color:'var(--blue)' }}>{children}</span>
      {action}
    </div>
  )
}

export function Btn({ children, onClick, disabled, variant='default', fullWidth, size='md' }) {
  const pad = size==='sm'?'5px 12px':size==='lg'?'12px 24px':'8px 18px'
  const fs  = size==='sm'?11:size==='lg'?14:12
  const styles = {
    default: { background:'rgba(96,165,250,0.1)', border:'1px solid var(--border2)', color:'var(--blue)' },
    primary: { background:'linear-gradient(135deg,#3b82f6,#1d4ed8)', border:'none', color:'#fff', boxShadow:'0 4px 16px rgba(59,130,246,0.3)' },
    ghost:   { background:'transparent', border:'1px solid var(--border)', color:'var(--t2)' },
    danger:  { background:'rgba(248,113,113,0.1)', border:'1px solid rgba(248,113,113,0.4)', color:'var(--red)' },
  }
  const v = styles[variant]||styles.default
  return (
    <button onClick={onClick} disabled={disabled}
      style={{...v, padding:pad, borderRadius:'var(--r)', fontSize:fs, fontWeight:600, fontFamily:'var(--mono)',
        letterSpacing:'0.02em', width:fullWidth?'100%':undefined,
        opacity:disabled?0.38:1, cursor:disabled?'not-allowed':'pointer', transition:'all .15s'}}
      onMouseEnter={e=>{if(!disabled)e.currentTarget.style.filter='brightness(1.15)'}}
      onMouseLeave={e=>{e.currentTarget.style.filter=''}}
      onMouseDown={e=>{if(!disabled)e.currentTarget.style.transform='scale(0.97)'}}
      onMouseUp={e=>{e.currentTarget.style.transform=''}}>
      {children}
    </button>
  )
}

const YAML_RULES = [
  { test: l => l.trimStart().startsWith('#'),                                color:'#475569' },
  { test: l => /^(apiVersion|kind|metadata|spec|data|stringData|type):/.test(l.trimStart()), color:'#93c5fd' },
  { test: l => /^\s+[\w\-\.]+:/.test(l) && !l.trimStart().startsWith('-'),  color:'#bfdbfe' },
  { test: l => /"[^"]*"/.test(l),                                            color:'#86efac' },
  { test: l => /:\s+\d+$/.test(l.trimEnd()),                                 color:'#fde68a' },
  { test: l => /:\s+(true|false|null|\[\])/.test(l),                         color:'#f9a8d4' },
]

export function YamlCode({ code }) {
  if (!code) return null
  return (
    <>
      {code.split('\n').map((line, i) => {
        const rule = YAML_RULES.find(r => r.test(line))
        return <span key={i} style={{ color:rule?.color??'#cbd5e1', display:'block', minHeight:'1.6em' }}>{line||'\u00a0'}</span>
      })}
    </>
  )
}
