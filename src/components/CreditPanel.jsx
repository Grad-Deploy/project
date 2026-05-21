import { useState, useMemo } from 'react'
import { SERVICE_TEMPLATES } from '../engines/guardrail'

// ── 리소스 → 예상 비용 계산 (AWS 기준 근사) ───────────────
function parseMilli(v) {
  if (!v) return 0
  if (String(v).endsWith('m')) return parseInt(v) / 1000
  return parseFloat(v)
}
function parseMiB(v) {
  if (!v) return 0
  if (String(v).endsWith('Gi')) return parseFloat(v) * 1024
  if (String(v).endsWith('Mi')) return parseFloat(v)
  return parseFloat(v)
}

// t3.medium 기준 USD/hour per vCPU=0.0416, per GiB=0.0052
const USD_PER_VCPU_H  = 0.0416
const USD_PER_GIB_H   = 0.0052
const KRW_PER_USD     = 1380

function calcDailyCost(services) {
  let totalCPU = 0, totalMemMiB = 0
  services.forEach(svc => {
    const rep = parseInt(svc.replicas) || 1
    const t   = SERVICE_TEMPLATES[svc.type] || {}
    totalCPU    += parseMilli(svc.cpuReq || t.cpuReq) * rep
    totalMemMiB += parseMiB(svc.memReq || t.memReq) * rep
  })
  const hourly = totalCPU * USD_PER_VCPU_H + (totalMemMiB / 1024) * USD_PER_GIB_H
  return { hourly, daily: hourly * 24, totalCPU, totalMemMiB }
}

// ── 미니 Bar ──────────────────────────────────────────────
function Bar({ ratio, color, height = 6 }) {
  return (
    <div style={{ height, background: 'rgba(255,255,255,0.07)', borderRadius: 4, overflow: 'hidden' }}>
      <div style={{
        height: '100%', width: `${Math.min(100, ratio * 100)}%`,
        background: color, borderRadius: 4,
        transition: 'width .4s ease',
      }} />
    </div>
  )
}

export default function CreditPanel({ services }) {
  const [credit, setCredit] = useState(100)     // 잔여 크레딧 USD
  const [demoDate, setDemoDate] = useState('')  // 발표일 (YYYY-MM-DD)

  const { hourly, daily, totalCPU, totalMemMiB } = useMemo(
    () => calcDailyCost(services),
    [services]
  )

  // 소진 예상일
  const burnDays = daily > 0 ? Math.floor(credit / daily) : Infinity
  const burnDate = daily > 0
    ? new Date(Date.now() + burnDays * 86400000).toLocaleDateString('ko-KR')
    : '소진 없음'

  // D-day 계산
  let dday = null
  if (demoDate) {
    const demo = new Date(demoDate)
    const today = new Date()
    dday = Math.ceil((demo - today) / 86400000)
  }

  const status = dday === null ? 'unknown'
    : burnDays > dday + 3 ? 'safe'
    : burnDays > dday     ? 'warn'
    : 'danger'

  const STATUS_CFG = {
    safe:    { color: 'var(--green)',  label: '충분', icon: '✓' },
    warn:    { color: 'var(--amber)',  label: '주의', icon: '⚠' },
    danger:  { color: 'var(--red)',    label: '위험', icon: '✕' },
    unknown: { color: 'var(--t3)',     label: '-',    icon: '·' },
  }
  const sc = STATUS_CFG[status]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* 입력 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="잔여 크레딧 (USD)">
          <input
            type="number" value={credit}
            onChange={e => setCredit(Number(e.target.value))}
            min={0}
            style={inputStyle}
          />
        </Field>
        <Field label="발표일">
          <input
            type="date" value={demoDate}
            onChange={e => setDemoDate(e.target.value)}
            style={inputStyle}
          />
        </Field>
      </div>

      {/* 요약 카드 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        <StatCard label="시간당 비용" value={`$${hourly.toFixed(4)}`} sub={`₩${(hourly * KRW_PER_USD).toFixed(0)}/h`} color="var(--blue)" />
        <StatCard label="일 비용" value={`$${daily.toFixed(3)}`}       sub={`₩${(daily * KRW_PER_USD).toFixed(0)}/day`} color="var(--amber)" />
        <StatCard label="예상 소진일" value={burnDays === Infinity ? '∞' : `${burnDays}일`}  sub={burnDate} color="var(--purple)" />
      </div>

      {/* D-day 상태 */}
      {demoDate && (
        <div style={{
          padding: '14px 16px', borderRadius: 'var(--r2)',
          background: `${sc.color}10`,
          border: `1px solid ${sc.color}30`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--t2)' }}>발표일까지 남은 기간</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: sc.color, lineHeight: 1.2 }}>
              {dday !== null ? (dday >= 0 ? `D-${dday}` : `D+${Math.abs(dday)}`) : '-'}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{
              fontSize: 28, fontWeight: 800, color: sc.color,
              fontFamily: 'var(--disp)',
            }}>
              {sc.icon}
            </div>
            <div style={{ fontSize: 12, color: sc.color, fontWeight: 600 }}>{sc.label}</div>
          </div>
        </div>
      )}

      {/* 리소스 사용량 분석 */}
      <section>
        <SHead>리소스 분석</SHead>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--t2)' }}>총 CPU Request</span>
              <span style={{ fontSize: 11, color: 'var(--blue)', fontFamily: 'var(--mono)' }}>
                {totalCPU.toFixed(2)} vCPU
              </span>
            </div>
            <Bar ratio={totalCPU / 4} color="var(--blue)" />
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--t2)' }}>총 Memory Request</span>
              <span style={{ fontSize: 11, color: 'var(--purple)', fontFamily: 'var(--mono)' }}>
                {(totalMemMiB / 1024).toFixed(2)} GiB
              </span>
            </div>
            <Bar ratio={totalMemMiB / (8 * 1024)} color="var(--purple)" />
          </div>
        </div>
      </section>

      {/* 서비스별 비용 */}
      <section>
        <SHead>서비스별 예상 비용</SHead>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
          {services.map(svc => {
            const t   = SERVICE_TEMPLATES[svc.type] || {}
            const rep = parseInt(svc.replicas) || 1
            const cpu = parseMilli(svc.cpuReq || t.cpuReq) * rep
            const mem = parseMiB(svc.memReq || t.memReq) * rep / 1024
            const svcDaily = (cpu * USD_PER_VCPU_H + mem * USD_PER_GIB_H) * 24
            const ratio = daily > 0 ? svcDaily / daily : 0

            return (
              <div key={svc.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '6px 10px', borderRadius: 'var(--r)',
                background: 'rgba(255,255,255,0.02)',
              }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                  background: t.color || 'var(--t3)',
                }} />
                <span style={{ fontSize: 11, color: 'var(--t2)', flex: 1, fontFamily: 'var(--mono)' }}>
                  {svc.name}
                  {rep > 1 && <span style={{ color: 'var(--t3)' }}> ×{rep}</span>}
                </span>
                <div style={{ width: 80 }}>
                  <Bar ratio={ratio} color={t.color || 'var(--blue)'} height={4} />
                </div>
                <span style={{ fontSize: 10, color: 'var(--t3)', minWidth: 60, textAlign: 'right', fontFamily: 'var(--mono)' }}>
                  ${svcDaily.toFixed(3)}/d
                </span>
              </div>
            )
          })}
          {services.length === 0 && (
            <div style={{ color: 'var(--t3)', fontSize: 11, textAlign: 'center', padding: 16 }}>
              서비스를 추가하면 비용이 계산됩니다
            </div>
          )}
        </div>
      </section>

      {/* 절약 팁 */}
      <div style={{
        padding: '10px 12px', borderRadius: 'var(--r)',
        background: 'rgba(82,156,255,0.06)',
        border: '1px solid rgba(82,156,255,0.15)',
        fontSize: 11, color: 'var(--t2)', lineHeight: 1.6,
      }}>
        💡 <strong style={{ color: 'var(--blue)' }}>절약 팁:</strong> 발표 시간 외에는 replicas를 0으로 줄이거나
        미사용 서비스를 일시 중단하세요. DB StatefulSet은 PVC를 유지하며 Deployment만 삭제 가능합니다.
      </div>
    </div>
  )
}

// ── 헬퍼 ──────────────────────────────────────────────────
function StatCard({ label, value, sub, color }) {
  return (
    <div style={{
      padding: '10px 12px', borderRadius: 'var(--r2)',
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid var(--border)',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 18, fontWeight: 700, color, lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 2, letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 3 }}>{sub}</div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</span>
      {children}
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

const inputStyle = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r)',
  color: 'var(--t1)', padding: '5px 9px',
  width: '100%', outline: 'none',
  fontFamily: 'var(--mono)', fontSize: 12,
}
