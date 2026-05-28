import { useEffect, useMemo, useState } from 'react'
import {
  CA_ENV_LABEL,
  CA_SEVERITY,
  detectBrowserResources,
  normalizeClusterInfo,
  parseKubeconfigSummary,
  parseVmInspectionOutput,
  readCloudNodesFromKubeconfig,
  runCA,
} from '../engines/ca'
import { Btn } from './Ui'

const VM_SCRIPT = `echo "CPU=$(nproc), MEM=$(free -g | awk '/Mem:/{print $2}')GB"
kubectl describe nodes | awk '/Allocatable:/{flag=1; print; next} flag && /^[^[:space:]]/{flag=0} flag{print}'`

const ENV_OPTIONS = [
  { key: 'local', label: '로컬 PC', icon: '💻' },
  { key: 'vm', label: 'VM', icon: '🖥️' },
  { key: 'cloud', label: '클라우드', icon: '☁️' },
]

const DEFAULT_NODES = [
  { id: 'master-1', name: 'master-1', role: 'master', cpu: 2, mem: 4 },
  { id: 'worker-1', name: 'worker-1', role: 'worker', cpu: 1, mem: 2 },
  { id: 'worker-2', name: 'worker-2', role: 'worker', cpu: 1, mem: 2 },
]

const isDefaultNodes = nodes => JSON.stringify(nodes) === JSON.stringify(DEFAULT_NODES)

const SEV = {
  ERROR: { color: 'var(--red)', bg: 'rgba(248,113,113,0.09)', bd: 'rgba(248,113,113,0.32)', icon: '✕' },
  WARNING: { color: 'var(--amber)', bg: 'rgba(251,191,36,0.08)', bd: 'rgba(251,191,36,0.28)', icon: '⚠' },
  INFO: { color: 'var(--green)', bg: 'rgba(74,222,128,0.07)', bd: 'rgba(74,222,128,0.26)', icon: '✓' },
}

export default function ClusterAdvisorPanel({ onCapacityChange, onRunRA }) {
  const [env, setEnv] = useState('local')
  const [detected, setDetected] = useState(null)
  const [host, setHost] = useState({ cpu: 4, mem: 8 })
  const [nodes, setNodes] = useState(DEFAULT_NODES)
  const [vmOutput, setVmOutput] = useState('')
  const [vmParseStatus, setVmParseStatus] = useState('')
  const [vmNodeSource, setVmNodeSource] = useState('manual')
  const [copied, setCopied] = useState(false)
  const [kubeconfig, setKubeconfig] = useState({ fileName: '', summary: null })
  const [cloudStatus, setCloudStatus] = useState('')

  useEffect(() => {
    const res = detectBrowserResources()
    setDetected(res)
    if (res.cpu || res.memHint) {
      setHost(current => ({
        cpu: res.cpu || current.cpu,
        mem: res.memHint || current.mem,
      }))
    }
  }, [])

  const clusterInfo = useMemo(
    () => normalizeClusterInfo({
      env,
      host,
      nodes,
      source: env === 'vm' ? { hostScope: 'node-allocatable', nodeDiscovery: vmNodeSource } : kubeconfig.summary,
    }),
    [env, host, nodes, kubeconfig.summary, vmNodeSource]
  )
  const caResult = useMemo(() => runCA(clusterInfo), [clusterInfo])
  const clusterJson = useMemo(() => JSON.stringify(clusterInfo, null, 2), [clusterInfo])

  useEffect(() => {
    onCapacityChange?.({
      env,
      availableCPU: caResult.availableCPU,
      availableMem: caResult.availableMem,
      workloadNodeCount: caResult.summary.workloadNodeCount,
      hasError: caResult.hasError,
    })
  }, [
    onCapacityChange,
    env,
    caResult.availableCPU,
    caResult.availableMem,
    caResult.summary.workloadNodeCount,
    caResult.hasError,
  ])

  const selectEnv = nextEnv => {
    setEnv(nextEnv)
    if (nextEnv === 'local' && detected) {
      setHost(current => ({
        cpu: detected.cpu || current.cpu,
        mem: detected.memHint || current.mem,
      }))
    }
    if (nextEnv === 'vm' && isDefaultNodes(nodes)) {
      setNodes([{
        id: 'master-1',
        name: 'master-1',
        role: 'master',
        cpu: host.cpu || 2,
        mem: host.mem || 4,
      }])
      setVmNodeSource('manual')
    }
    if (nextEnv === 'cloud') {
      setHost(current => current.cpu && current.mem ? current : { cpu: 6, mem: 12 })
    }
  }

  const updateNode = (id, patch) => {
    if (env === 'vm') setVmNodeSource('manual')
    setNodes(list => list.map(node => node.id === id ? { ...node, ...patch } : node))
  }

  const addNode = role => {
    if (env === 'vm') setVmNodeSource('manual')
    setNodes(list => {
      const count = list.filter(node => node.role === role).length + 1
      return [
        ...list,
        {
          id: `${role}-${Date.now()}`,
          name: `${role}-${count}`,
          role,
          cpu: role === 'master' ? 2 : 1,
          mem: role === 'master' ? 4 : 2,
        },
      ]
    })
  }

  const removeNode = id => {
    if (env === 'vm') setVmNodeSource('manual')
    setNodes(list => list.length > 1 ? list.filter(node => node.id !== id) : list)
  }

  const copyScript = () => {
    navigator.clipboard?.writeText(VM_SCRIPT)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const parseVmOutput = () => {
    const parsed = parseVmInspectionOutput(vmOutput)
    if (parsed.host.cpu || parsed.host.mem) {
      setHost(current => ({
        cpu: parsed.host.cpu || current.cpu,
        mem: parsed.host.mem || current.mem,
      }))
    }
    if (parsed.nodes.length > 0) setNodes(parsed.nodes)
    setVmNodeSource('script')
    setVmParseStatus(`파싱 완료 · 노드 ${parsed.nodes.length}개`)
    setTimeout(() => setVmParseStatus(''), 1800)
  }

  const readKubeconfig = event => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      const text = String(reader.result || '')
      const summary = parseKubeconfigSummary(text)
      setKubeconfig({ fileName: file.name, summary })
      setCloudStatus(summary.detected ? 'kubeconfig 메타데이터 확인됨' : 'kubeconfig 구조를 확인하지 못했습니다')

      try {
        setCloudStatus('Kubernetes API에서 노드 정보를 조회하는 중...')
        const cloud = await readCloudNodesFromKubeconfig(text)
        if (cloud.host.cpu || cloud.host.mem) setHost(cloud.host)
        if (cloud.nodes.length > 0) setNodes(cloud.nodes)
        setCloudStatus(`노드 ${cloud.nodes.length}개 자동 조회 완료`)
      } catch (e) {
        setCloudStatus(e.message)
      }
    }
    reader.readAsText(file)
  }

  const summary = caResult.summary
  const envLabel = CA_ENV_LABEL[env]
  const hostLabel = env === 'vm' ? '스크립트 실행 노드' : envLabel
  const nodeResourceLabel = (env === 'vm' && vmNodeSource === 'script') || env === 'cloud'
    ? 'K8s 노드 Allocatable'
    : '노드 할당량'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section>
        <SHead>클러스터 진단</SHead>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 12 }}>
          {ENV_OPTIONS.map(option => {
            const active = env === option.key
            return (
              <button
                key={option.key}
                onClick={() => selectEnv(option.key)}
                style={{
                  minHeight: 64,
                  borderRadius: 'var(--r)',
                  border: `1px solid ${active ? 'var(--blue)' : 'var(--border2)'}`,
                  background: active ? 'rgba(96,165,250,0.14)' : 'rgba(255,255,255,0.03)',
                  color: active ? 'var(--blue)' : 'var(--t2)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  fontWeight: 700,
                }}
              >
                <span style={{ fontSize: 20, lineHeight: 1 }}>{option.icon}</span>
                <span style={{ fontSize: 11 }}>{option.label}</span>
              </button>
            )
          })}
        </div>
      </section>

      {env === 'local' && (
        <InfoBox color="var(--blue)">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span>브라우저 자동 감지</span>
            <strong style={{ color: 'var(--t1)' }}>
              {detected ? `${detected.cpu || '-'}core / ${detected.memDisplay}` : '확인 중'}
            </strong>
          </div>
          <div style={{ marginTop: 6 }}>
            브라우저 API 값은 자동 입력을 위한 힌트입니다. Chrome/Edge가 Safari보다 CPU/RAM 정보를 더 잘 노출하는 편이며,
            RAM은 실제 용량으로 직접 보정하는 것이 가장 정확합니다.
          </div>
          {detected?.memHint >= 8 && (
            <div style={{ marginTop: 6, color: 'var(--amber)' }}>
              deviceMemory는 8GB 이상을 구분하지 못해 필요하면 실제 RAM으로 보정하세요.
            </div>
          )}
          {!detected?.memHint && (
            <div style={{ marginTop: 6, color: 'var(--amber)' }}>
              현재 브라우저가 RAM 정보를 제공하지 않습니다. Safari에서는 정상적인 제한일 수 있습니다.
            </div>
          )}
        </InfoBox>
      )}

      {env === 'vm' && (
        <section style={panelStyle}>
          <SHead>VM 스크립트</SHead>
          <div style={{ marginTop: 8, color: 'var(--t3)', fontSize: 11, lineHeight: 1.55 }}>
            VM 환경은 마스터 노드에서 스크립트를 실행하고, 각 노드의 Allocatable 기준으로 분석합니다.
            물리 호스트 안전범위 검사는 로컬 PC 환경에만 적용합니다.
          </div>
          <pre style={codeBoxStyle}>{VM_SCRIPT}</pre>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, marginTop: 10 }}>
            <textarea
              value={vmOutput}
              onChange={e => setVmOutput(e.target.value)}
              placeholder="VM 터미널 실행 결과를 붙여넣어 주세요"
              style={{ ...textAreaStyle, minHeight: 86 }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Btn size="sm" onClick={copyScript}>{copied ? '복사됨' : '복사'}</Btn>
              <Btn size="sm" variant="primary" onClick={parseVmOutput} disabled={!vmOutput.trim()}>파싱</Btn>
            </div>
          </div>
          {vmParseStatus && (
            <div style={{ marginTop: 8, color: 'var(--green)', fontSize: 11, lineHeight: 1.5 }}>
              {vmParseStatus}
            </div>
          )}
        </section>
      )}

      {env === 'cloud' && (
        <section style={panelStyle}>
          <SHead>kubeconfig</SHead>
          <label style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            marginTop: 10,
            padding: '11px 12px',
            borderRadius: 'var(--r)',
            border: '1px dashed var(--border2)',
            background: 'rgba(255,255,255,0.03)',
            color: 'var(--t2)',
            cursor: 'pointer',
          }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {kubeconfig.fileName || 'kubeconfig 파일 선택'}
            </span>
            <span style={{ color: 'var(--blue)', fontWeight: 700, fontSize: 11 }}>업로드</span>
            <input type="file" onChange={readKubeconfig} style={{ display: 'none' }} />
          </label>
          {kubeconfig.summary?.detected && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11, color: 'var(--t2)' }}>
              <Meta label="context" value={kubeconfig.summary.currentContext || '-'} />
              <Meta label="server" value={kubeconfig.summary.server || '-'} />
              <Meta label="clusters" value={kubeconfig.summary.clusterNames.join(', ') || '-'} />
              <Meta label="auth" value={kubeconfig.summary.hasToken ? 'static token' : kubeconfig.summary.hasExecAuth ? 'exec auth' : '-'} />
            </div>
          )}
          {cloudStatus && (
            <div style={{
              marginTop: 10,
              color: cloudStatus.includes('완료') ? 'var(--green)' : cloudStatus.includes('조회하는 중') ? 'var(--blue)' : 'var(--amber)',
              fontSize: 11,
              lineHeight: 1.55,
            }}>
              {cloudStatus}
            </div>
          )}
        </section>
      )}

      <section style={panelStyle}>
        <SHead>실행 환경 사양</SHead>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          <NumberField label={`${hostLabel} CPU`} value={host.cpu} onChange={v => setHost({ ...host, cpu: v })} suffix="core" />
          <NumberField label={`${hostLabel} Memory`} value={host.mem} onChange={v => setHost({ ...host, mem: v })} suffix="GB" />
        </div>
      </section>

      <section style={panelStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <SHead compact>{nodeResourceLabel}</SHead>
          <div style={{ display: 'flex', gap: 6 }}>
            <Btn size="sm" onClick={() => addNode('master')}>+ Master</Btn>
            <Btn size="sm" onClick={() => addNode('worker')}>+ Worker</Btn>
          </div>
        </div>
        <div style={{ marginTop: 8, color: 'var(--t3)', fontSize: 11, lineHeight: 1.55 }}>
          {env === 'vm' || env === 'cloud'
            ? vmNodeSource === 'script' || env === 'cloud'
              ? 'CPU/Memory는 노드가 소비한 양이 아니라, kubectl에서 조회한 파드 스케줄링 가능 용량입니다.'
              : 'CPU/Memory는 실행 VM 안에서 각 노드에 배정할 용량입니다. 노드 합산이 실행 VM 사양을 넘으면 잔여 용량으로 제한합니다.'
            : 'CPU/Memory는 로컬 호스트에서 각 VM/노드에 할당할 용량입니다.'}
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1.2fr 82px 72px 72px 28px',
          gap: 6,
          marginTop: 10,
          padding: '0 8px',
          color: 'var(--t3)',
          fontSize: 10,
          letterSpacing: '0.04em',
        }}>
          <span>노드명</span>
          <span>역할</span>
          <span>CPU</span>
          <span>Memory</span>
          <span />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
          {nodes.map(node => (
            <NodeRow key={node.id} node={node} onChange={patch => updateNode(node.id, patch)} onRemove={() => removeNode(node.id)} />
          ))}
        </div>
      </section>

      <section style={panelStyle}>
        <SHead>클러스터 분석 결과</SHead>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
          <Stat label={env === 'vm' ? '스크립트 실행 노드' : '호스트'} value={`${summary.hostCPU}core / ${summary.hostMem}GB`} color="var(--blue)" />
          <Stat label="노드" value={`M${summary.masterCount} + W${summary.workerCount}`} color="var(--purple)" />
          <Stat label="파드 배치 노드" value={`${summary.workloadNodeCount}개`} color="var(--cyan)" />
          <Stat
            label="계산 기준"
            value={summary.checksSingleHostCapacity ? 'VM 상한 적용' : summary.isAllocatableInput ? 'Allocatable' : 'Node Spec'}
            color="var(--cyan)"
          />
          <Stat label="파드 할당 가능 CPU" value={`${summary.availableCPU}m`} color="var(--green)" />
          <Stat label="파드 할당 가능 메모리" value={`${summary.availableMem}Mi`} color="var(--green)" />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {caResult.issues.map(issue => <Issue key={issue.id} issue={issue} />)}
        </div>

        <div style={{
          marginTop: 12,
          padding: '10px 12px',
          borderRadius: 'var(--r)',
          background: 'rgba(34,211,238,0.06)',
          border: '1px solid rgba(34,211,238,0.2)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
        }}>
          <div style={{ fontSize: 11, color: 'var(--t2)', lineHeight: 1.55 }}>
            RA 입력값: CPU <strong style={{ color: 'var(--cyan)' }}>{caResult.availableCPU}m</strong>,
            Memory <strong style={{ color: 'var(--cyan)' }}>{caResult.availableMem}Mi</strong>
            <span style={{ display: 'block', color: 'var(--t3)' }}>
              현재 사용량/잔여량이 아니라 파드 request로 배정할 수 있는 총량 기준입니다.
            </span>
          </div>
          <Btn size="sm" variant="primary" onClick={onRunRA}>RA 실행</Btn>
        </div>
      </section>

      <details style={panelStyle}>
        <summary style={{ cursor: 'pointer', color: 'var(--blue)', fontWeight: 700, fontSize: 11 }}>
          clusterInfo JSON
        </summary>
        <pre style={{ ...codeBoxStyle, marginTop: 10, maxHeight: 220, overflow: 'auto' }}>{clusterJson}</pre>
      </details>
    </div>
  )
}

function NodeRow({ node, onChange, onRemove }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1.2fr 82px 72px 72px 28px',
      gap: 6,
      alignItems: 'center',
      padding: '8px',
      borderRadius: 'var(--r)',
      border: '1px solid var(--border)',
      background: 'rgba(255,255,255,0.025)',
    }}>
      <input value={node.name} onChange={e => onChange({ name: e.target.value })} style={inputStyle} />
      <select value={node.role} onChange={e => onChange({ role: e.target.value })} style={inputStyle}>
        <option value="master" style={{ background: 'var(--bg2)' }}>master</option>
        <option value="worker" style={{ background: 'var(--bg2)' }}>worker</option>
      </select>
      <input type="number" min="0" step="0.5" value={node.cpu} onChange={e => onChange({ cpu: e.target.value })} style={inputStyle} />
      <input type="number" min="0" step="0.5" value={node.mem} onChange={e => onChange({ mem: e.target.value })} style={inputStyle} />
      <button onClick={onRemove} title="노드 제거" style={{ color: 'var(--red)', fontSize: 16 }}>×</button>
    </div>
  )
}

function NumberField({ label, value, onChange, suffix }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 10, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</span>
      <div style={{ position: 'relative' }}>
        <input type="number" min="0" step="0.5" value={value} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, paddingRight: 48 }} />
        <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--t3)', fontSize: 10 }}>{suffix}</span>
      </div>
    </label>
  )
}

function Stat({ label, value, color }) {
  return (
    <div style={{
      padding: '11px 10px',
      textAlign: 'center',
      borderRadius: 'var(--r)',
      border: '1px solid var(--border)',
      background: 'rgba(255,255,255,0.025)',
    }}>
      <div style={{ color, fontSize: 18, fontWeight: 800, lineHeight: 1.2 }}>{value}</div>
      <div style={{ color: 'var(--t3)', fontSize: 10, marginTop: 4, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</div>
    </div>
  )
}

function Issue({ issue }) {
  const cfg = SEV[issue.severity] || SEV[CA_SEVERITY.WARNING]
  return (
    <div style={{
      padding: '11px 12px',
      borderRadius: 'var(--r)',
      background: cfg.bg,
      border: `1px solid ${cfg.bd}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 5 }}>
        <span style={{ color: cfg.color, fontSize: 11, fontWeight: 800 }}>
          {cfg.icon} {issue.rule}
        </span>
        <span style={{ color: cfg.color, fontSize: 10, fontWeight: 800 }}>{issue.severity}</span>
      </div>
      <div style={{ color: 'var(--t1)', fontSize: 12, lineHeight: 1.55 }}>{issue.message}</div>
      <div style={{ color: 'var(--t3)', fontSize: 11, lineHeight: 1.55, marginTop: 4 }}>→ {issue.suggestion}</div>
    </div>
  )
}

function InfoBox({ children, color }) {
  return (
    <div style={{
      padding: '11px 12px',
      borderRadius: 'var(--r)',
      border: `1px solid ${color}30`,
      background: `${color}10`,
      color: 'var(--t2)',
      fontSize: 11,
      lineHeight: 1.55,
    }}>
      {children}
    </div>
  )
}

function Meta({ label, value }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr', gap: 8 }}>
      <span style={{ color: 'var(--t3)' }}>{label}</span>
      <span style={{ color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  )
}

function SHead({ children, compact = false }) {
  return (
    <div style={{
      fontSize: 10,
      fontWeight: 700,
      color: 'var(--blue)',
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      paddingBottom: compact ? 0 : 6,
      borderBottom: compact ? 'none' : '1px solid var(--border)',
    }}>{children}</div>
  )
}

const panelStyle = {
  padding: 12,
  borderRadius: 'var(--r2)',
  border: '1px solid var(--border2)',
  background: 'rgba(255,255,255,0.025)',
}

const inputStyle = {
  width: '100%',
  height: 32,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r)',
  color: 'var(--t1)',
  padding: '6px 8px',
  outline: 'none',
  fontSize: 11,
  fontFamily: 'var(--mono)',
}

const textAreaStyle = {
  width: '100%',
  resize: 'vertical',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r)',
  color: 'var(--t1)',
  padding: '9px 10px',
  outline: 'none',
  fontSize: 11,
  fontFamily: 'var(--mono)',
  lineHeight: 1.55,
}

const codeBoxStyle = {
  margin: '10px 0 0',
  padding: '10px 12px',
  borderRadius: 'var(--r)',
  border: '1px solid rgba(96,165,250,0.18)',
  background: '#050810',
  color: '#cbd5e1',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontSize: 11,
  lineHeight: 1.55,
  fontFamily: 'var(--mono)',
}
