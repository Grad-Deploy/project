import { useState } from 'react'
import { SERVICE_TEMPLATES } from '../engines/guardrail'
import { Input, Select, Toggle } from './Ui'

// ── 서비스 타입별 추천 이미지 ────────────────────────────────
const RECOMMENDED_IMAGES = {
  'spring-boot': [
    { label: 'eclipse-temurin:21',    value: 'eclipse-temurin:21-jre-alpine',  desc: 'LTS · Alpine 경량 · 권장' },
    { label: 'eclipse-temurin:17',    value: 'eclipse-temurin:17-jre-alpine',  desc: 'LTS · Alpine 경량' },
    { label: 'amazoncorretto:21',     value: 'amazoncorretto:21-alpine',        desc: 'AWS 최적화 · EKS 권장' },
  ],
  'node-backend': [
    { label: 'node:20-alpine',        value: 'node:20-alpine',                  desc: 'LTS · 가장 가벼움 · 권장' },
    { label: 'node:20-slim',          value: 'node:20-slim',                    desc: 'LTS · 보안 패치 포함' },
    { label: 'node:18-alpine',        value: 'node:18-alpine',                  desc: 'LTS · 구버전 호환' },
  ],
  'python-flask': [
    { label: 'python:3.12-slim',      value: 'python:3.12-slim',                desc: '최신 · 경량 · 권장' },
    { label: 'python:3.11-slim',      value: 'python:3.11-slim',                desc: '안정적 · 검증됨' },
    { label: 'python:3.12-alpine',    value: 'python:3.12-alpine',              desc: '초경량 (빌드 도구 주의)' },
  ],
  'react-nginx': [
    { label: 'nginx:1.25-alpine',     value: 'nginx:1.25-alpine',               desc: '최신 stable · 경량 · 권장' },
    { label: 'nginx:stable-alpine',   value: 'nginx:stable-alpine',             desc: '항상 최신 stable 추적' },
    { label: 'nginx:1.24-alpine',     value: 'nginx:1.24-alpine',               desc: '이전 stable · 안정적' },
  ],
  mysql: [
    { label: 'mysql:8.0',             value: 'mysql:8.0',                       desc: '가장 많이 사용 · 권장' },
    { label: 'mysql:8.4',             value: 'mysql:8.4',                       desc: 'LTS · 장기 지원' },
    { label: 'mysql:5.7',             value: 'mysql:5.7',                       desc: '구버전 호환 필요 시' },
  ],
  redis: [
    { label: 'redis:7-alpine',        value: 'redis:7-alpine',                  desc: '최신 · 경량 · 권장' },
    { label: 'redis:7.2-alpine',      value: 'redis:7.2-alpine',                desc: '특정 버전 고정' },
    { label: 'redis:6-alpine',        value: 'redis:6-alpine',                  desc: '구버전 호환 필요 시' },
  ],
  mongodb: [
    { label: 'mongo:7.0',             value: 'mongo:7.0',                       desc: '최신 · 권장' },
    { label: 'mongo:6.0',             value: 'mongo:6.0',                       desc: '안정적 LTS' },
    { label: 'mongo:5.0',             value: 'mongo:5.0',                       desc: '구버전 호환 필요 시' },
  ],
}

const TYPE_OPTIONS = Object.entries(SERVICE_TEMPLATES).map(([value, t]) => ({
  value, label: `${t.icon}  ${t.label}`,
}))

// ── ImagePicker ──────────────────────────────────────────────
function ImagePicker({ svcType, value, onChange }) {
  const recs = RECOMMENDED_IMAGES[svcType] || []

  // 사용자가 명시적으로 '직접 입력' 모드를 선택했는지만 추적
  // 그 외에는 value에 따라 자동 판단
  const [forceCustom, setForceCustom] = useState(false)

  // 현재 mode = forceCustom 이거나, value가 추천 목록에 없으면 custom
  const isInRecs = recs.some(r => r.value === value)
  const mode = forceCustom || (value && !isInRecs) ? 'custom' : 'preset'

  const handlePresetClick = (imgValue) => {
    setForceCustom(false)
    onChange(imgValue)
  }

  const handleCustomMode = () => {
    setForceCustom(true)
    if (isInRecs) onChange('')   // 추천값이었던 경우만 비움 (사용자 입력값은 유지)
  }

  const isPresetSelected = (imgValue) => mode === 'preset' && value === imgValue

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* 라벨 */}
      <span style={{
        fontSize: 11, fontWeight: 600, color: 'var(--t2)',
        letterSpacing: '0.06em', textTransform: 'uppercase',
      }}>
        이미지
      </span>

      {/* 추천 이미지 카드 3개 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
        {recs.map((rec, idx) => {
          const selected = isPresetSelected(rec.value)
          return (
            <button
              key={rec.value}
              onClick={() => handlePresetClick(rec.value)}
              style={{
                padding: '9px 10px',
                borderRadius: 'var(--r)',
                cursor: 'pointer',
                border: `1px solid ${selected ? 'var(--blue)' : 'var(--border2)'}`,
                background: selected
                  ? 'rgba(96,165,250,0.14)'
                  : 'rgba(255,255,255,0.03)',
                textAlign: 'left',
                fontFamily: 'var(--mono)',
                transition: 'all .15s',
                position: 'relative',
              }}
              onMouseEnter={e => {
                if (!selected) {
                  e.currentTarget.style.borderColor = 'rgba(96,165,250,0.5)'
                  e.currentTarget.style.background  = 'rgba(96,165,250,0.06)'
                }
              }}
              onMouseLeave={e => {
                if (!selected) {
                  e.currentTarget.style.borderColor = 'var(--border2)'
                  e.currentTarget.style.background  = 'rgba(255,255,255,0.03)'
                }
              }}
            >
              {/* 첫 번째 항목에 '권장' 뱃지 */}
              {idx === 0 && (
                <span style={{
                  position: 'absolute', top: 5, right: 6,
                  fontSize: 8, fontWeight: 700,
                  color: 'var(--green)', letterSpacing: '0.05em',
                  background: 'rgba(74,222,128,0.12)',
                  padding: '1px 5px', borderRadius: 3,
                }}>
                  권장
                </span>
              )}

              {/* 라디오 + 이미지명 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                  border: `2px solid ${selected ? 'var(--blue)' : 'var(--t3)'}`,
                  background: selected ? 'var(--blue)' : 'transparent',
                  transition: 'all .15s',
                }} />
                <span style={{
                  fontSize: 11, fontWeight: selected ? 600 : 400,
                  color: selected ? 'var(--blue)' : 'var(--t1)',
                  lineHeight: 1.3,
                  wordBreak: 'break-all',
                }}>
                  {rec.label}
                </span>
              </div>

              {/* 설명 */}
              <div style={{
                fontSize: 10, color: 'var(--t3)',
                lineHeight: 1.4, paddingLeft: 14,
              }}>
                {rec.desc}
              </div>
            </button>
          )
        })}
      </div>

      {/* 직접 입력 토글 */}
      <button
        onClick={handleCustomMode}
        style={{
          padding: '7px 12px',
          borderRadius: 'var(--r)',
          cursor: 'pointer',
          border: `1px solid ${mode === 'custom' ? 'var(--cyan)' : 'var(--border)'}`,
          background: mode === 'custom' ? 'rgba(34,211,238,0.07)' : 'transparent',
          color: mode === 'custom' ? 'var(--cyan)' : 'var(--t3)',
          fontSize: 11, fontFamily: 'var(--mono)',
          textAlign: 'left',
          display: 'flex', alignItems: 'center', gap: 7,
          transition: 'all .15s',
        }}
      >
        <span style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          border: `2px solid ${mode === 'custom' ? 'var(--cyan)' : 'var(--t3)'}`,
          background: mode === 'custom' ? 'var(--cyan)' : 'transparent',
          transition: 'all .15s',
        }} />
        직접 입력
        <span style={{ color: 'var(--t3)', fontSize: 10, marginLeft: 2 }}>
          (Private Registry / 커스텀 태그)
        </span>
      </button>

      {/* 직접 입력 필드 */}
      {mode === 'custom' && (
        <input
          autoFocus
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="예: myregistry.io/myapp:1.2.3  또는  ghcr.io/org/app:sha"
          style={{
            background: 'rgba(34,211,238,0.05)',
            border: '1px solid var(--cyan)',
            borderRadius: 'var(--r)',
            color: 'var(--t1)',
            padding: '8px 12px',
            fontSize: 13, fontFamily: 'var(--mono)',
            width: '100%', outline: 'none',
            transition: 'border-color .15s',
          }}
          onFocus={e => e.target.style.borderColor = 'var(--cyan)'}
          onBlur={e  => e.target.style.borderColor = 'var(--cyan)'}
        />
      )}

      {/* 현재 선택된 이미지 확인 표시 */}
      {value && (
        <div style={{
          padding: '6px 10px', borderRadius: 'var(--r)',
          background: 'rgba(74,222,128,0.05)',
          border: '1px solid rgba(74,222,128,0.2)',
          fontSize: 11, color: 'var(--t2)',
          display: 'flex', alignItems: 'center', gap: 6,
          fontFamily: 'var(--mono)', wordBreak: 'break-all',
        }}>
          <span style={{ color: 'var(--green)', flexShrink: 0, fontSize: 12 }}>✓</span>
          <span style={{ color: 'var(--t1)' }}>{value}</span>
        </div>
      )}

      {/* 이미지 미선택 경고 */}
      {!value && (
        <div style={{
          padding: '5px 10px', borderRadius: 'var(--r)',
          background: 'rgba(251,191,36,0.06)',
          border: '1px solid rgba(251,191,36,0.2)',
          fontSize: 11, color: 'var(--amber)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span>⚠</span>
          이미지를 선택하거나 직접 입력하세요
        </div>
      )}
    </div>
  )
}

// ── 메인 ServiceCard ─────────────────────────────────────────
export default function ServiceCard({ svc, allSvcs, issues, isOpen, onToggle, onUpdate, onDelete }) {
  const t      = SERVICE_TEMPLATES[svc.type] || {}
  const others = allSvcs.filter(x => x.id !== svc.id).map(x => x.name)
  const errN   = issues.filter(i => i.severity === 'ERROR').length
  const warnN  = issues.filter(i => i.severity === 'WARNING').length
  const upd    = patch => onUpdate(svc.id, patch)
  const open   = isOpen

  const borderColor = errN > 0
    ? 'rgba(248,113,113,0.5)'
    : warnN > 0
      ? 'rgba(251,191,36,0.4)'
      : 'var(--border2)'

  return (
    <div style={{
      border: `1px solid ${borderColor}`,
      borderRadius: 'var(--r2)',
      background: 'rgba(255,255,255,0.02)',
      overflow: 'hidden',
      transition: 'border-color .2s',
    }}>

      {/* ── 헤더 */}
      <div
        onClick={() => onToggle(svc.id)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px', cursor: 'pointer',
          background: open ? 'rgba(96,165,250,0.05)' : 'transparent',
          userSelect: 'none',
        }}
      >
        <span style={{
          width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
          background: t.color || 'var(--t3)',
          boxShadow: `0 0 8px ${t.color || 'transparent'}55`,
        }} />
        <span style={{ fontWeight: 600, color: 'var(--t1)', flex: 1, fontSize: 14 }}>{svc.name}</span>

        {/* 이미지 축약 표시 */}
        {svc.image ? (
          <span style={{
            fontSize: 10, color: 'var(--green)',
            maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontFamily: 'var(--mono)',
          }}>
            {svc.image}
          </span>
        ) : (
          <span style={{ fontSize: 10, color: 'var(--amber)' }}>이미지 미선택</span>
        )}

        <span style={{
          fontSize: 10, color: 'var(--t3)',
          background: 'rgba(255,255,255,0.05)',
          padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)',
        }}>{t.label}</span>

        {t.isDB && (
          <span style={{
            fontSize: 10, color: 'var(--purple)',
            background: 'rgba(192,132,252,0.1)',
            padding: '2px 7px', borderRadius: 4,
          }}>
            StatefulSet
          </span>
        )}

        {errN > 0  && <span style={{ fontSize: 11, color: 'var(--red)',   fontWeight: 700 }}>✕ {errN}</span>}
        {warnN > 0 && <span style={{ fontSize: 11, color: 'var(--amber)', fontWeight: 600 }}>⚠ {warnN}</span>}

        <button
          onClick={e => { e.stopPropagation(); onDelete(svc.id) }}
          style={{ color: 'var(--t3)', fontSize: 18, lineHeight: 1, padding: '0 2px', background: 'none', border: 'none', cursor: 'pointer' }}
        >×</button>
        <span style={{ color: 'var(--t3)', fontSize: 11 }}>{open ? '▲' : '▼'}</span>
      </div>

      {/* ── 바디 */}
      {open && (
        <div style={{
          padding: '16px',
          borderTop: '1px solid var(--border2)',
          display: 'flex', flexDirection: 'column', gap: 16,
        }}>

          {/* 서비스명 + 유형 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="서비스명" value={svc.name} onChange={v => upd({ name: v })} placeholder="svc-name" />
            <Select label="유형" value={svc.type} onChange={v => {
              const t2 = SERVICE_TEMPLATES[v] || {}
              upd({
                type: v,
                cpuReq: t2.cpuReq, memReq: t2.memReq,
                cpuLim: t2.cpuLim || '', memLim: t2.memLim || '',
                liveness: t2.liveness || '', readiness: t2.readiness || '',
                port: t2.port || 8080, startupProbe: t2.isJVM || false,
                image: '',  // 유형 변경 시 이미지 초기화
              })
            }} options={TYPE_OPTIONS} />
          </div>

          {/* 이미지 피커 */}
          <ImagePicker
            svcType={svc.type}
            value={svc.image}
            onChange={v => upd({ image: v })}
          />

          {/* Port / Replicas / PDB */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <Input label="Port"             type="number" value={svc.port}     onChange={v => upd({ port: +v })} />
            <Input label="Replicas"         type="number" value={svc.replicas} onChange={v => upd({ replicas: +v })} />
            <Input label="PDB minAvailable" type="number" value={svc.pdbMin}   onChange={v => upd({ pdbMin: v })} placeholder="없음" />
          </div>

          {/* 리소스 */}
          <Group label="RESOURCES">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
              <Input label="CPU Req" value={svc.cpuReq} onChange={v => upd({ cpuReq: v })} placeholder="100m" />
              <Input label="Mem Req" value={svc.memReq} onChange={v => upd({ memReq: v })} placeholder="256Mi" />
              <Input label="CPU Lim" value={svc.cpuLim} onChange={v => upd({ cpuLim: v })} placeholder="없음" />
              <Input label="Mem Lim" value={svc.memLim} onChange={v => upd({ memLim: v })} placeholder="512Mi" />
            </div>
          </Group>

          {/* Probe */}
          <Group label="PROBE">
            {t.isDB ? (
              // DB 서비스: httpGet 불가, exec 방식으로 자동 생성
              <div style={{
                padding: '10px 12px', borderRadius: 'var(--r)',
                background: 'rgba(96,165,250,0.06)',
                border: '1px solid rgba(96,165,250,0.2)',
                display: 'flex', flexDirection: 'column', gap: 6,
              }}>
                <div style={{ fontSize: 12, color: 'var(--blue)', fontWeight: 600 }}>
                  ⓘ exec 방식으로 자동 설정됩니다
                </div>
                <div style={{ fontSize: 11, color: 'var(--t2)', lineHeight: 1.65 }}>
                  DB 서비스는 HTTP 엔드포인트가 없어 <code style={{ color: 'var(--cyan)', background: 'rgba(34,211,238,0.08)', padding: '1px 5px', borderRadius: 3 }}>httpGet</code> 방식을 사용할 수 없습니다.
                  아래 명령어로 Probe가 자동 생성됩니다.
                </div>
                <div style={{
                  padding: '7px 10px', borderRadius: 4,
                  background: 'rgba(0,0,0,0.3)',
                  fontFamily: 'var(--mono)', fontSize: 11,
                  color: 'var(--green)',
                }}>
                  {svc.type === 'mysql'   && 'mysqladmin ping -h localhost'}
                  {svc.type === 'redis'   && 'redis-cli ping'}
                  {svc.type === 'mongodb' && "mongosh --eval \"db.adminCommand('ping')\" --quiet"}
                </div>
              </div>
            ) : (
              // 일반 서비스: httpGet 경로 입력
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Input label="Liveness Path"  value={svc.liveness}  onChange={v => upd({ liveness: v })}  placeholder="/healthz" />
                <Input label="Readiness Path" value={svc.readiness} onChange={v => upd({ readiness: v })} placeholder="/ready" />
              </div>
            )}
            <div style={{ display: 'flex', gap: 20, marginTop: 8, flexWrap: 'wrap' }}>
              <Toggle label="Startup Probe" checked={svc.startupProbe} onChange={v => upd({ startupProbe: v })} />
              <Toggle label="HPA"           checked={svc.hpa}          onChange={v => upd({ hpa: v })} />
              <Toggle label="외부 노출"      checked={svc.expose}       onChange={v => upd({ expose: v })} />
              <Toggle label="Privileged"    checked={svc.privileged}   onChange={v => upd({ privileged: v })} />
            </div>
          </Group>

          {/* HPA */}
          {svc.hpa && (
            <Group label="HPA">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Input label="Max Replicas" type="number" value={svc.maxRep} onChange={v => upd({ maxRep: +v })} />
                <div style={{ paddingTop: 22 }}>
                  <Toggle label="Stabilization Window" checked={svc.hpaWindow} onChange={v => upd({ hpaWindow: v })} />
                </div>
              </div>
            </Group>
          )}

          {/* Depends On */}
          {others.length > 0 && (
            <Group label="DEPENDS ON">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {others.map(name => {
                  const active = (svc.deps || []).includes(name)
                  return (
                    <button key={name} onClick={() => {
                      const cur = svc.deps || []
                      upd({ deps: active ? cur.filter(x => x !== name) : [...cur, name] })
                    }} style={{
                      padding: '4px 10px', borderRadius: 5, fontSize: 12,
                      border: `1px solid ${active ? 'var(--blue)' : 'var(--border2)'}`,
                      background: active ? 'rgba(96,165,250,0.14)' : 'transparent',
                      color: active ? 'var(--blue)' : 'var(--t2)',
                      cursor: 'pointer', fontFamily: 'var(--mono)', transition: 'all .15s',
                    }}>{name}</button>
                  )
                })}
              </div>
            </Group>
          )}

          {/* 인라인 이슈 */}
          {issues.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {issues.slice(0, 3).map(issue => {
                const isErr = issue.severity === 'ERROR'
                return (
                  <div key={issue.id} style={{
                    display: 'flex', gap: 10, alignItems: 'flex-start',
                    padding: '8px 12px', borderRadius: 'var(--r)',
                    background: isErr ? 'rgba(248,113,113,0.09)' : 'rgba(251,191,36,0.08)',
                    border: `1px solid ${isErr ? 'rgba(248,113,113,0.3)' : 'rgba(251,191,36,0.25)'}`,
                  }}>
                    <span style={{ color: isErr ? 'var(--red)' : 'var(--amber)', fontSize: 12, flexShrink: 0, marginTop: 1 }}>
                      {isErr ? '✕' : '⚠'}
                    </span>
                    <div>
                      <div style={{ fontSize: 12, color: 'var(--t1)', lineHeight: 1.5 }}>
                        {issue.message.replace(/^\[[^\]]+\]\s*/, '')}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 3 }}>→ {issue.suggestion}</div>
                    </div>
                  </div>
                )
              })}
              {issues.length > 3 && (
                <span style={{ fontSize: 11, color: 'var(--t3)', paddingLeft: 4 }}>
                  + {issues.length - 3}건 더 — 가드레일 탭 확인
                </span>
              )}
            </div>
          )}

        </div>
      )}
    </div>
  )
}

function Group({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{
        fontSize: 10, fontWeight: 700, color: 'var(--blue)',
        letterSpacing: '0.12em', textTransform: 'uppercase',
      }}>
        {label}
      </span>
      {children}
    </div>
  )
}
