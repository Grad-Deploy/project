// ════════════════════════════════════════════════════════
//  ServiceCard.jsx (EnvEditor 통합 버전)
// ════════════════════════════════════════════════════════

import { useState } from 'react'
import { SERVICE_TEMPLATES } from '../engines/guardrail'
import { Input, Select, Toggle } from './Ui'
import EnvEditorComponent, { ResourceWarningBanner } from './EnvEditor'

const RECOMMENDED_IMAGES = {
  'spring-boot': [
    { label: 'eclipse-temurin:21', value: 'eclipse-temurin:21-jre-alpine', desc: 'LTS · Alpine 경량 · 권장' },
    { label: 'eclipse-temurin:17', value: 'eclipse-temurin:17-jre-alpine', desc: 'LTS · Alpine 경량' },
    { label: 'amazoncorretto:21',  value: 'amazoncorretto:21-alpine',       desc: 'AWS 최적화 · EKS 권장' },
  ],
  'node-backend': [
    { label: 'node:20-alpine', value: 'node:20-alpine', desc: 'LTS · 가장 가벼움 · 권장' },
    { label: 'node:20-slim',   value: 'node:20-slim',   desc: 'LTS · 보안 패치 포함' },
    { label: 'node:18-alpine', value: 'node:18-alpine', desc: 'LTS · 구버전 호환' },
  ],
  'python-flask': [
    { label: 'python:3.12-slim',   value: 'python:3.12-slim',   desc: '최신 · 경량 · 권장' },
    { label: 'python:3.11-slim',   value: 'python:3.11-slim',   desc: '안정적 · 검증됨' },
    { label: 'python:3.12-alpine', value: 'python:3.12-alpine', desc: '초경량 (빌드 도구 주의)' },
  ],
  'react-nginx': [
    { label: 'nginx:1.25-alpine',   value: 'nginx:1.25-alpine',   desc: '최신 stable · 경량 · 권장' },
    { label: 'nginx:stable-alpine', value: 'nginx:stable-alpine', desc: '항상 최신 stable 추적' },
    { label: 'nginx:1.24-alpine',   value: 'nginx:1.24-alpine',   desc: '이전 stable · 안정적' },
  ],
  'nextjs': [
    { label: 'node:20-alpine', value: 'node:20-alpine', desc: 'LTS · 가장 가벼움 · 권장' },
    { label: 'node:20-slim',   value: 'node:20-slim',   desc: 'LTS · 보안 패치 포함' },
    { label: 'node:18-alpine', value: 'node:18-alpine', desc: 'LTS · 구버전 호환' },
  ],
  // nginx(리버스 프록시)도 동일한 이미지 사용
  'nginx': [
    { label: 'nginx:1.25-alpine',   value: 'nginx:1.25-alpine',   desc: '최신 stable · 경량 · 권장' },
    { label: 'nginx:stable-alpine', value: 'nginx:stable-alpine', desc: '항상 최신 stable 추적' },
    { label: 'nginx:1.24-alpine',   value: 'nginx:1.24-alpine',   desc: '이전 stable · 안정적' },
  ],
  mysql: [
    { label: 'mysql:8.0', value: 'mysql:8.0', desc: '가장 많이 사용 · 권장' },
    { label: 'mysql:8.4', value: 'mysql:8.4', desc: 'LTS · 장기 지원' },
    { label: 'mysql:5.7', value: 'mysql:5.7', desc: '구버전 호환 필요 시' },
  ],
  postgresql: [
    { label: 'postgres:16-alpine', value: 'postgres:16-alpine', desc: '최신 · 경량 · 권장' },
    { label: 'postgres:15-alpine', value: 'postgres:15-alpine', desc: 'LTS · 안정적' },
    { label: 'postgres:14-alpine', value: 'postgres:14-alpine', desc: '구버전 호환 필요 시' },
  ],
  redis: [
    { label: 'redis:7-alpine',   value: 'redis:7-alpine',   desc: '최신 · 경량 · 권장' },
    { label: 'redis:7.2-alpine', value: 'redis:7.2-alpine', desc: '특정 버전 고정' },
    { label: 'redis:6-alpine',   value: 'redis:6-alpine',   desc: '구버전 호환 필요 시' },
  ],
  mongodb: [
    { label: 'mongo:7.0', value: 'mongo:7.0', desc: '최신 · 권장' },
    { label: 'mongo:6.0', value: 'mongo:6.0', desc: '안정적 LTS' },
    { label: 'mongo:5.0', value: 'mongo:5.0', desc: '구버전 호환 필요 시' },
  ],
  elasticsearch: [
    { label: 'elasticsearch:8.12.0', value: 'docker.elastic.co/elasticsearch/elasticsearch:8.12.0', desc: '최신 stable · 권장' },
    { label: 'elasticsearch:8.11.4', value: 'docker.elastic.co/elasticsearch/elasticsearch:8.11.4', desc: '안정적 이전 버전' },
    { label: 'elasticsearch:7.17.18',value: 'docker.elastic.co/elasticsearch/elasticsearch:7.17.18', desc: 'v7 LTS · 레거시 호환' },
  ],
}

const TYPE_OPTIONS = Object.entries(SERVICE_TEMPLATES).map(([value, t]) => ({
  value, label: `${t.icon}  ${t.label}`,
}))

function ImagePicker({ svcType, value, onChange }) {
  const recs = RECOMMENDED_IMAGES[svcType] || []
  const [forceCustom, setForceCustom] = useState(false)
  const isInRecs = recs.some(r => r.value === value)
  const mode = forceCustom || (value && !isInRecs) ? 'custom' : 'preset'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--t2)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        이미지
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
        {recs.map((rec, idx) => {
          const selected = mode === 'preset' && value === rec.value
          return (
            <button
              key={rec.value}
              onClick={() => { setForceCustom(false); onChange(rec.value) }}
              style={{
                padding: '9px 10px', borderRadius: 'var(--r)', cursor: 'pointer',
                border: `1px solid ${selected ? 'var(--blue)' : 'var(--border2)'}`,
                background: selected ? 'rgba(96,165,250,0.14)' : 'rgba(255,255,255,0.03)',
                textAlign: 'left', fontFamily: 'var(--mono)', transition: 'all .15s',
                position: 'relative',
              }}
            >
              {idx === 0 && (
                <span style={{
                  position: 'absolute', top: 5, right: 6, fontSize: 8, fontWeight: 700,
                  color: 'var(--green)', background: 'rgba(74,222,128,0.12)',
                  padding: '1px 5px', borderRadius: 3,
                }}>권장</span>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                  border: `2px solid ${selected ? 'var(--blue)' : 'var(--t3)'}`,
                  background: selected ? 'var(--blue)' : 'transparent',
                }} />
                <span style={{ fontSize: 11, fontWeight: selected ? 600 : 400, color: selected ? 'var(--blue)' : 'var(--t1)', wordBreak: 'break-all' }}>
                  {rec.label}
                </span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--t3)', lineHeight: 1.4, paddingLeft: 14 }}>{rec.desc}</div>
            </button>
          )
        })}
      </div>
      <button
        onClick={() => { setForceCustom(true); if (isInRecs) onChange('') }}
        style={{
          padding: '7px 12px', borderRadius: 'var(--r)', cursor: 'pointer',
          border: `1px solid ${mode === 'custom' ? 'var(--cyan)' : 'var(--border)'}`,
          background: mode === 'custom' ? 'rgba(34,211,238,0.07)' : 'transparent',
          color: mode === 'custom' ? 'var(--cyan)' : 'var(--t3)',
          fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'left',
          display: 'flex', alignItems: 'center', gap: 7, transition: 'all .15s',
        }}
      >
        <span style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          border: `2px solid ${mode === 'custom' ? 'var(--cyan)' : 'var(--t3)'}`,
          background: mode === 'custom' ? 'var(--cyan)' : 'transparent',
        }} />
        직접 입력
      </button>
      {mode === 'custom' && (
        <Input
          value={value}
          onChange={onChange}
          placeholder="예: myregistry.io/myapp:1.0.0"
        />
      )}
    </div>
  )
}

function Group({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--blue)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
        {label}
      </span>
      {children}
    </div>
  )
}

// ── ServiceCard (EnvEditor 통합 완성본) ────────────────
// Props:
//   svc            - 현재 서비스 객체 (raw state)
//   issues         - 가드레일 이슈 배열
//   upd            - 서비스 업데이트 함수
//   del            - 서비스 삭제 함수
//   open           - 아코디언 열림 여부
//   onToggle       - 아코디언 토글
//   others         - 다른 서비스명 배열 (deps 선택용)
//   allServices    - ⚠️ 반드시 propagatedServices를 전달해야 함
//   nginxCount     - 현재 nginx/react-nginx 서비스 총 수 (삭제 보호용)
export default function ServiceCard({ svc, issues, upd, del, open, onToggle, others, allServices = [], nginxCount = 1 }) {
  const t = SERVICE_TEMPLATES[svc.type] || {}
  const issueCount = issues.length
  // guardrail 이슈: severity='ERROR'(대문자), envIssues: severity='error'(소문자) 모두 처리
  const errorCount = issues.filter(i => i.severity?.toUpperCase() === 'ERROR').length

  // nginx/react-nginx가 마지막 1개면 삭제 불가
  const isNginxType = svc.type === 'nginx' || svc.type === 'react-nginx'
  const isLocked = isNginxType && nginxCount <= 1

  const headerBg = errorCount > 0
    ? 'rgba(248,113,113,0.07)'
    : issueCount > 0
      ? 'rgba(251,191,36,0.05)'
      : 'rgba(255,255,255,0.03)'

  const borderColor = errorCount > 0
    ? 'rgba(248,113,113,0.35)'
    : issueCount > 0
      ? 'rgba(251,191,36,0.3)'
      : 'var(--border2)'

  return (
    <div style={{
      borderRadius: 'var(--r2)',
      border: `1px solid ${borderColor}`,
      background: 'var(--bg2)',
      overflow: 'hidden',
      transition: 'border-color .2s',
    }}>
      {/* 헤더 */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 14px',
          background: headerBg,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 18 }}>{t.icon || '◻'}</span>
        <div style={{ flex: 1 }}>
          <div style={{
            fontSize: 13, fontWeight: 700, color: 'var(--t1)',
            fontFamily: 'var(--mono)',
          }}>{svc.name}</div>
          <div style={{ fontSize: 10, color: 'var(--t3)' }}>{t.label} · :{svc.port || t.port}</div>
        </div>
        {issueCount > 0 && (
          <span style={{
            fontSize: 10, fontWeight: 700,
            color: errorCount > 0 ? 'var(--red)' : 'var(--amber)',
            background: errorCount > 0 ? 'rgba(248,113,113,0.12)' : 'rgba(251,191,36,0.12)',
            padding: '2px 8px', borderRadius: 10,
          }}>
            {errorCount > 0 ? `✕ ${errorCount}` : `⚠ ${issueCount}`}
          </span>
        )}
        {/* nginx 필수 서비스 잠금 뱃지 */}
        {isLocked && (
          <span style={{
            fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
            background: 'rgba(34,211,238,0.12)', color: 'var(--cyan)',
            border: '1px solid rgba(34,211,238,0.3)',
          }}>
            필수
          </span>
        )}
        <button
          onClick={e => { e.stopPropagation(); if (!isLocked) del() }}
          disabled={isLocked}
          title={isLocked ? 'nginx는 최소 1개 이상 필요합니다' : '삭제'}
          style={{
            background: 'none', border: 'none',
            color: isLocked ? 'var(--t4)' : 'var(--t3)',
            cursor: isLocked ? 'not-allowed' : 'pointer',
            fontSize: 16, padding: '2px 6px',
            borderRadius: 4, transition: 'color .15s',
          }}
          onMouseEnter={e => { if (!isLocked) e.currentTarget.style.color = 'var(--red)' }}
          onMouseLeave={e => { e.currentTarget.style.color = isLocked ? 'var(--t4)' : 'var(--t3)' }}
        >×</button>
        <span style={{ color: 'var(--t3)', fontSize: 11 }}>{open ? '▲' : '▼'}</span>
      </div>

      {/* 바디 */}
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
                image: '',
              })
            }} options={TYPE_OPTIONS} />
          </div>

          {/* 이미지 피커 */}
          <ImagePicker svcType={svc.type} value={svc.image} onChange={v => upd({ image: v })} />

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
              <div style={{
                padding: '10px 12px', borderRadius: 'var(--r)',
                background: 'rgba(96,165,250,0.06)',
                border: '1px solid rgba(96,165,250,0.2)',
              }}>
                <div style={{ fontSize: 12, color: 'var(--blue)', fontWeight: 600, marginBottom: 4 }}>
                  ⓘ exec 방식으로 자동 설정됩니다
                </div>
                <div style={{
                  padding: '7px 10px', borderRadius: 4,
                  background: 'rgba(0,0,0,0.3)',
                  fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--green)',
                }}>
                  {svc.type === 'mysql'   && 'mysqladmin ping -h localhost'}
                  {svc.type === 'redis'   && 'redis-cli ping'}
                  {svc.type === 'mongodb' && "mongosh --eval \"db.adminCommand('ping')\" --quiet"}
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Input label="Liveness Path"  value={svc.liveness}  onChange={v => upd({ liveness: v })}  placeholder="/healthz" />
                <Input label="Readiness Path" value={svc.readiness} onChange={v => upd({ readiness: v })} placeholder="/ready" />
              </div>
            )}
            <div style={{ display: 'flex', gap: 20, marginTop: 8, flexWrap: 'wrap' }}>
              <Toggle label="Startup Probe" checked={svc.startupProbe} onChange={v => upd({ startupProbe: v })} />
              <Toggle label="HPA"           checked={svc.hpa}          onChange={v => upd({ hpa: v })} />
              <Toggle label="외부 노출"      checked={svc.expose}       onChange={v => upd({ expose: v })} />
              <Toggle label="Pod 분산 (AntiAffinity)" checked={svc.antiAffinity} onChange={v => upd({ antiAffinity: v })} />
              <Toggle label="Privileged"    checked={svc.privileged}   onChange={v => upd({ privileged: v })} />
            </div>

            {/* Ingress 경로 — expose=true이고 DB가 아닌 서비스만 표시 */}
            {svc.expose && !t.isDB && (
              <div style={{
                marginTop: 4,
                padding: '10px 12px',
                borderRadius: 'var(--r)',
                background: 'rgba(96,165,250,0.05)',
                border: '1px solid rgba(96,165,250,0.2)',
              }}>
                <div style={{ fontSize: 10, color: 'var(--blue)', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
                  Ingress 경로 (kind / 로컬)
                </div>
                <Input
                  value={svc.ingressPath || ''}
                  onChange={v => upd({ ingressPath: v })}
                  placeholder={`/${svc.name}`}
                  hint={`미입력 시 /${svc.name} 으로 자동 생성 · kind Nginx Ingress Controller 필요`}
                />
              </div>
            )}
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

          {/* ✅ NEW: 환경변수 설정 (EnvEditor 통합) */}
          {/* allServices: propagatedServices를 전달받아야 연결 정보 일관성 검증이 정확히 동작 */}
          {/* env: svc.env(원본)를 편집 대상으로 사용. propagated 값은 EnvEditor 내부에서 allServices로 참조 */}
          <Group label="ENVIRONMENT VARIABLES">
            <EnvEditorComponent
              svc={svc}
              env={svc.env || {}}
              onChange={env => upd({ env })}
              allServices={allServices}
            />
          </Group>

          {/* 인라인 이슈 */}
          {issues.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {issues.slice(0, 3).map(issue => {
                // guardrail 이슈: 'ERROR'(대문자), envIssues: 'error'(소문자) 모두 처리
                const isErr = issue.severity?.toUpperCase() === 'ERROR'
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
