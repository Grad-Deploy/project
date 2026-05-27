import { useState, useMemo } from 'react'
import { categorizeEnvVar, ENV_SPEC, validateEnvVars, calcResourceWarnings } from '../utils/envManager'

// ── 카테고리 뱃지 ───────────────────────────────────────
function CategoryBadge({ category }) {
  const isSecret = category === 'secret'
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: '2px 6px',
      borderRadius: 3, letterSpacing: '0.06em',
      background: isSecret ? 'rgba(248,113,113,0.12)' : 'rgba(82,156,255,0.12)',
      color: isSecret ? 'var(--red)' : 'var(--blue)',
      border: `1px solid ${isSecret ? 'rgba(248,113,113,0.3)' : 'rgba(82,156,255,0.3)'}`,
      flexShrink: 0,
    }}>
      {isSecret ? '🔒 SECRET' : '⚙ CONFIG'}
    </span>
  )
}

// ── 단일 환경변수 행 ────────────────────────────────────
function EnvRow({ envKey, value, onChange, onDelete, autoHint }) {
  const category = categorizeEnvVar(envKey)
  const isSecret = category === 'secret'
  const [showVal, setShowVal] = useState(false)

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr auto auto',
      gap: 6,
      alignItems: 'center',
      padding: '6px 10px',
      borderRadius: 'var(--r)',
      background: isSecret ? 'rgba(248,113,113,0.04)' : 'rgba(255,255,255,0.02)',
      border: `1px solid ${isSecret ? 'rgba(248,113,113,0.15)' : 'var(--border)'}`,
    }}>
      {/* 키 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <CategoryBadge category={category} />
        <span style={{
          fontSize: 11, fontFamily: 'var(--mono)',
          color: 'var(--t1)', fontWeight: 600,
          wordBreak: 'break-all',
        }}>
          {envKey}
        </span>
      </div>

      {/* 값 */}
      <div style={{ position: 'relative' }}>
        <input
          type={isSecret && !showVal ? 'password' : 'text'}
          value={value}
          onChange={e => onChange(envKey, e.target.value)}
          placeholder={autoHint || '값 입력'}
          autoComplete="off"
          style={{
            width: '100%',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid var(--border2)',
            borderRadius: 'var(--r)',
            color: 'var(--t1)',
            padding: '5px 28px 5px 9px',
            fontSize: 11,
            fontFamily: 'var(--mono)',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        {isSecret && (
          <button
            onClick={() => setShowVal(v => !v)}
            style={{
              position: 'absolute', right: 6, top: '50%',
              transform: 'translateY(-50%)',
              background: 'none', border: 'none',
              cursor: 'pointer', color: 'var(--t3)',
              fontSize: 12, padding: 0,
            }}
            title={showVal ? '숨기기' : '보기'}
          >
            {showVal ? '🙈' : '👁'}
          </button>
        )}
      </div>

      {/* 삭제 */}
      <button
        onClick={() => onDelete(envKey)}
        style={{
          background: 'none', border: 'none',
          color: 'var(--t3)', cursor: 'pointer',
          fontSize: 14, padding: '2px 6px',
          borderRadius: 4,
          transition: 'color .15s',
        }}
        onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
        onMouseLeave={e => e.currentTarget.style.color = 'var(--t3)'}
        title="삭제"
      >×</button>
    </div>
  )
}

// ── 새 환경변수 추가 행 ─────────────────────────────────
function AddEnvRow({ onAdd }) {
  const [key, setKey] = useState('')
  const [val, setVal] = useState('')

  const handleAdd = () => {
    const k = key.trim().toUpperCase().replace(/\s+/g, '_')
    if (!k) return
    onAdd(k, val)
    setKey('')
    setVal('')
  }

  const preview = categorizeEnvVar(key.trim())

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr auto',
      gap: 6,
      alignItems: 'center',
      padding: '6px 10px',
      borderRadius: 'var(--r)',
      background: 'rgba(255,255,255,0.01)',
      border: '1px dashed var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {key.trim() && <CategoryBadge category={preview} />}
        <input
          value={key}
          onChange={e => setKey(e.target.value)}
          placeholder="KEY_NAME"
          autoComplete="off"
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          style={{
            flex: 1,
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid var(--border2)',
            borderRadius: 'var(--r)',
            color: 'var(--t1)',
            padding: '5px 9px',
            fontSize: 11,
            fontFamily: 'var(--mono)',
            outline: 'none',
          }}
        />
      </div>
      <input
        value={val}
        onChange={e => setVal(e.target.value)}
        placeholder="값"
        autoComplete="off"
        type={key.trim() && categorizeEnvVar(key.trim()) === 'secret' ? 'password' : 'text'}
        onKeyDown={e => e.key === 'Enter' && handleAdd()}
        style={{
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid var(--border2)',
          borderRadius: 'var(--r)',
          color: 'var(--t1)',
          padding: '5px 9px',
          fontSize: 11,
          fontFamily: 'var(--mono)',
          outline: 'none',
        }}
      />
      <button
        onClick={handleAdd}
        disabled={!key.trim()}
        style={{
          background: key.trim() ? 'rgba(82,156,255,0.15)' : 'transparent',
          border: `1px solid ${key.trim() ? 'var(--blue)' : 'var(--border)'}`,
          color: key.trim() ? 'var(--blue)' : 'var(--t3)',
          borderRadius: 'var(--r)',
          cursor: key.trim() ? 'pointer' : 'not-allowed',
          padding: '5px 12px',
          fontSize: 11,
          fontFamily: 'var(--mono)',
          transition: 'all .15s',
        }}
      >
        + 추가
      </button>
    </div>
  )
}

// ── DB 서비스용 필수 환경변수 빠른 설정 ─────────────────
function DbQuickFill({ svcType, onFill }) {
  const spec = ENV_SPEC[svcType]
  if (!spec) return null

  return (
    <div style={{
      padding: '10px 12px',
      borderRadius: 'var(--r)',
      background: 'rgba(82,156,255,0.05)',
      border: '1px solid rgba(82,156,255,0.2)',
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700, color: 'var(--blue)',
        letterSpacing: '0.1em', textTransform: 'uppercase',
        marginBottom: 8,
      }}>
        ⚡ 필수 환경변수 빠른 추가
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {Object.entries(spec.provides).map(([k, meta]) => (
          <button
            key={k}
            onClick={() => onFill(k, '')}
            style={{
              padding: '4px 8px',
              borderRadius: 4,
              fontSize: 10,
              fontFamily: 'var(--mono)',
              background: meta.category === 'secret'
                ? 'rgba(248,113,113,0.1)'
                : 'rgba(82,156,255,0.1)',
              border: `1px solid ${meta.category === 'secret'
                ? 'rgba(248,113,113,0.3)'
                : 'rgba(82,156,255,0.3)'}`,
              color: meta.category === 'secret' ? 'var(--red)' : 'var(--blue)',
              cursor: 'pointer',
              transition: 'all .15s',
            }}
            title={meta.hint}
          >
            + {k}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 6 }}>
        버튼 클릭 시 키가 추가됩니다. 값은 직접 입력하세요.
      </div>
    </div>
  )
}

// ── 메인 EnvEditor 컴포넌트 ────────────────────────────
export default function EnvEditor({ svc, env = {}, onChange, allServices = [] }) {
  const entries = Object.entries(env)
  const configEntries = entries.filter(([k]) => categorizeEnvVar(k) === 'configmap')
  const secretEntries = entries.filter(([k]) => categorizeEnvVar(k) === 'secret')

  // 이 서비스와 관련된 전역 env 검증 이슈
  const allIssues = useMemo(
    () => validateEnvVars(allServices),
    [allServices]
  )
  const svcIssues = allIssues.filter(i => i.svcName === svc.name)

  const handleChange = (key, value) => {
    onChange({ ...env, [key]: value })
  }

  const handleDelete = (key) => {
    const next = { ...env }
    delete next[key]
    onChange(next)
  }

  const handleAdd = (key, value) => {
    if (env[key] !== undefined) return // 중복 방지
    onChange({ ...env, [key]: value })
  }

  // DB 타입별 필수 환경변수 힌트
  const dbSpec = ENV_SPEC[svc.type]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* 검증 이슈 */}
      {svcIssues.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {svcIssues.map((issue, i) => (
            <div key={i} style={{
              padding: '8px 12px',
              borderRadius: 'var(--r)',
              background: issue.severity === 'error'
                ? 'rgba(248,113,113,0.08)'
                : 'rgba(251,191,36,0.06)',
              border: `1px solid ${issue.severity === 'error'
                ? 'rgba(248,113,113,0.3)'
                : 'rgba(251,191,36,0.25)'}`,
              fontSize: 11,
            }}>
              <div style={{
                color: issue.severity === 'error' ? 'var(--red)' : 'var(--amber)',
                fontWeight: 600, marginBottom: 3,
              }}>
                {issue.severity === 'error' ? '✕' : '⚠'} {issue.message}
              </div>
              <div style={{ color: 'var(--t3)' }}>→ {issue.suggestion}</div>
            </div>
          ))}
        </div>
      )}

      {/* DB 서비스용 빠른 설정 */}
      {dbSpec && (
        <DbQuickFill svcType={svc.type} onFill={handleAdd} />
      )}

      {/* ConfigMap 섹션 */}
      {configEntries.length > 0 && (
        <div>
          <div style={{
            fontSize: 10, fontWeight: 700, color: 'var(--blue)',
            letterSpacing: '0.1em', textTransform: 'uppercase',
            marginBottom: 6,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: 'var(--blue)', display: 'inline-block',
            }} />
            ConfigMap ({configEntries.length})
            <span style={{ fontSize: 9, color: 'var(--t3)', fontWeight: 400 }}>
              — Git 커밋 안전
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {configEntries.map(([k, v]) => (
              <EnvRow
                key={k}
                envKey={k}
                value={v}
                onChange={handleChange}
                onDelete={handleDelete}
                autoHint={dbSpec?.provides[k]?.hint}
              />
            ))}
          </div>
        </div>
      )}

      {/* Secret 섹션 */}
      {secretEntries.length > 0 && (
        <div>
          <div style={{
            fontSize: 10, fontWeight: 700, color: 'var(--red)',
            letterSpacing: '0.1em', textTransform: 'uppercase',
            marginBottom: 6,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: 'var(--red)', display: 'inline-block',
            }} />
            Secret ({secretEntries.length})
            <span style={{ fontSize: 9, color: 'var(--t3)', fontWeight: 400 }}>
              — .gitignore 보호
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {secretEntries.map(([k, v]) => (
              <EnvRow
                key={k}
                envKey={k}
                value={v}
                onChange={handleChange}
                onDelete={handleDelete}
                autoHint={dbSpec?.provides[k]?.hint}
              />
            ))}
          </div>
        </div>
      )}

      {/* 빈 상태 */}
      {entries.length === 0 && (
        <div style={{
          padding: '16px',
          textAlign: 'center',
          color: 'var(--t3)',
          fontSize: 12,
          border: '1px dashed var(--border)',
          borderRadius: 'var(--r)',
        }}>
          환경변수가 없습니다.<br />
          아래에서 추가하거나 DB 빠른 설정을 사용하세요.
        </div>
      )}

      {/* 추가 행 */}
      <AddEnvRow onAdd={handleAdd} />

      {/* 분류 안내 */}
      <div style={{
        fontSize: 10, color: 'var(--t3)', lineHeight: 1.6,
        padding: '8px 10px',
        borderRadius: 'var(--r)',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid var(--border)',
      }}>
        💡 <strong style={{ color: 'var(--t2)' }}>자동 분류:</strong>{' '}
        키 이름에 <code style={{ color: 'var(--amber)' }}>password / secret / token / key</code>가
        포함되면 자동으로 <span style={{ color: 'var(--red)' }}>Secret</span>으로 분류됩니다.
        나머지는 <span style={{ color: 'var(--blue)' }}>ConfigMap</span>으로 처리됩니다.
      </div>
    </div>
  )
}

// ── 리소스 경고 배너 ────────────────────────────────────
export function ResourceWarningBanner({ services }) {
  const { totalRamMi, warnings } = useMemo(
    () => calcResourceWarnings(services),
    [services]
  )

  if (warnings.length === 0) return null

  return (
    <div style={{
      padding: '10px 14px',
      borderRadius: 'var(--r)',
      background: 'rgba(251,191,36,0.07)',
      border: '1px solid rgba(251,191,36,0.25)',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: 'var(--amber)',
        marginBottom: 2,
      }}>
        ⚠ 리소스 경고 · 총 {(totalRamMi / 1024).toFixed(1)} GB RAM 예상
      </div>
      {warnings.map((w, i) => (
        <div key={i} style={{ fontSize: 11, color: 'var(--t2)', lineHeight: 1.5 }}>
          · {w}
        </div>
      ))}
    </div>
  )
}

// ── 전체 서비스의 환경변수 전파 요약 뷰 ────────────────
export function EnvPropagationView({ services }) {
  const [expanded, setExpanded] = useState(false)

  // 전파 관계 계산
  const propagations = []
  const svcMap = Object.fromEntries(services.map(s => [s.name, s]))

  services.forEach(svc => {
    ; (svc.deps || []).forEach(depName => {
      const dep = svcMap[depName]
      if (!dep) return
      propagations.push({
        from: depName,
        fromType: dep.type,
        to: svc.name,
        toType: svc.type,
        keys: Object.keys(svc.env || {}).filter(k =>
          Object.keys(dep.env || {}).some(dk =>
            // 값이 같으면 전파된 것으로 간주
            svc.env[k] && dep.env[dk] && svc.env[k] === dep.env[dk]
          )
        ),
      })
    })
  })

  if (propagations.length === 0) return null

  return (
    <div style={{
      borderRadius: 'var(--r)',
      border: '1px solid var(--border)',
      overflow: 'hidden',
    }}>
      <button
        onClick={() => setExpanded(v => !v)}
        style={{
          width: '100%',
          padding: '10px 14px',
          background: 'rgba(255,255,255,0.02)',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{
          fontSize: 10, fontWeight: 700, color: 'var(--blue)',
          letterSpacing: '0.1em', textTransform: 'uppercase',
        }}>
          환경변수 전파 현황 · {propagations.length}개 연결
        </span>
        <span style={{ fontSize: 10, color: 'var(--t3)' }}>
          {expanded ? '▲ 접기' : '▼ 보기'}
        </span>
      </button>

      {expanded && (
        <div style={{
          padding: '12px',
          borderTop: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          {propagations.map((p, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              fontSize: 11, fontFamily: 'var(--mono)',
            }}>
              <span style={{ color: 'var(--t2)', fontWeight: 600 }}>{p.from}</span>
              <span style={{ color: 'var(--blue)' }}>──→</span>
              <span style={{ color: 'var(--t2)', fontWeight: 600 }}>{p.to}</span>
              {p.keys.length > 0 && (
                <span style={{ color: 'var(--t3)', fontSize: 10 }}>
                  ({p.keys.length}개 키 전파됨)
                </span>
              )}
            </div>
          ))}
          <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 4, lineHeight: 1.6 }}>
            서비스 간 연결(Depends On) 설정 시 DB 연결 정보가 자동으로 채워집니다.
          </div>
        </div>
      )}
    </div>
  )
}
