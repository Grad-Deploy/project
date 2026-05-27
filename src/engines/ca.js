// ══════════════════════════════════════════════════════
//  CA · Cluster Advisor (pure functions)
// ══════════════════════════════════════════════════════

export const CA_SEVERITY = { ERROR: 'ERROR', WARNING: 'WARNING', INFO: 'INFO' }

let _id = 0
const mk = (severity, rule, message, suggestion) => ({
  id: `CA-${rule}-${++_id}`,
  engine: 'CA',
  severity,
  rule,
  message,
  suggestion,
})

export const SYSTEM_RESERVE = {
  master: { cpu: 500, mem: 1536 },
  worker: { cpu: 100, mem: 400 },
}

export const WORKLOAD_POLICY = {
  workersOnly: 'workers-only',
  singleNodeControlPlane: 'single-node-control-plane',
}

export const CA_ENV_LABEL = {
  local: '로컬 PC',
  vm: 'VM',
  cloud: '클라우드',
}

const toNumber = value => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

const roleOf = role => (role === 'master' || role === 'control-plane') ? 'master' : 'worker'
const round = (value, digits = 2) => Number(Number(value || 0).toFixed(digits))
const fmt = (value, digits = 1) => Number(value || 0).toFixed(digits).replace(/\.0$/, '')

export function normalizeClusterInfo(input = {}) {
  const env = ['local', 'vm', 'cloud'].includes(input.env) ? input.env : 'local'
  const host = {
    cpu: toNumber(input.host?.cpu),
    mem: toNumber(input.host?.mem),
  }
  const nodes = Array.isArray(input.nodes)
    ? input.nodes.map((node, index) => ({
        id: node.id || `node-${index + 1}`,
        name: node.name || `${roleOf(node.role)}-${index + 1}`,
        role: roleOf(node.role),
        cpu: toNumber(node.cpu),
        mem: toNumber(node.mem),
      }))
    : []

  return { env, host, nodes, source: input.source || null }
}

export function detectBrowserResources(nav = globalThis.navigator) {
  const cpu = nav?.hardwareConcurrency || null
  const memHint = nav?.deviceMemory || null

  return {
    cpu,
    memHint,
    memDisplay: memHint ? (memHint >= 8 ? '8GB 이상' : `${memHint}GB`) : '감지 불가',
    reliable: cpu !== null && memHint !== null,
  }
}

export function parseVmInspectionOutput(text = '') {
  const source = String(text)
  const cpuMatch = source.match(/CPU\s*=\s*(\d+(?:\.\d+)?)/i)
  const memMatch = source.match(/MEM\s*=\s*(\d+(?:\.\d+)?)\s*GB/i)
  const host = {
    cpu: cpuMatch ? Number(cpuMatch[1]) : 0,
    mem: memMatch ? Number(memMatch[1]) : 0,
  }

  const allocatableBlocks = [...source.matchAll(/Allocatable:\s*([\s\S]*?)(?=\n\S|\n\n|$)/gi)]
  const nodes = allocatableBlocks.map((match, index) => {
    const block = match[1]
    const cpuLine = block.match(/cpu:\s*([0-9]+m?|[0-9.]+)/i)
    const memLine = block.match(/memory:\s*([0-9]+)(Ki|Mi|Gi)?/i)
    const cpuRaw = cpuLine?.[1] || '0'
    const memRaw = Number(memLine?.[1] || 0)
    const memUnit = memLine?.[2] || 'Ki'

    const cpu = cpuRaw.endsWith('m') ? Number(cpuRaw.slice(0, -1)) / 1000 : Number(cpuRaw)
    const mem = memUnit === 'Gi' ? memRaw : memUnit === 'Mi' ? memRaw / 1024 : memRaw / 1024 / 1024

    return {
      id: `vm-node-${index + 1}`,
      name: index === 0 ? 'master-1' : `worker-${index}`,
      role: index === 0 ? 'master' : 'worker',
      cpu: Number.isFinite(cpu) ? round(cpu, 3) : 0,
      mem: Number.isFinite(mem) ? round(mem, 3) : 0,
    }
  }).filter(node => node.cpu > 0 || node.mem > 0)

  return { host, nodes, source: { hostScope: 'node-allocatable' } }
}

export function parseKubeconfigSummary(text = '') {
  const source = String(text)
  const currentContext = source.match(/current-context:\s*([^\n]+)/)?.[1]?.trim() || ''
  const clusterNames = [...source.matchAll(/-\s*cluster:\s*[\s\S]*?\n\s*name:\s*([^\n]+)/g)]
    .map(match => match[1].trim())
  const server = source.match(/server:\s*([^\n]+)/)?.[1]?.trim() || ''
  const token = source.match(/token:\s*([^\n]+)/)?.[1]?.trim() || ''
  const hasExecAuth = /\n\s*exec:\s*\n/.test(source)

  return {
    currentContext,
    clusterNames: [...new Set(clusterNames)],
    server,
    hasToken: Boolean(token),
    hasExecAuth,
    detected: Boolean(currentContext || clusterNames.length || server),
  }
}

const parseK8sCPU = value => {
  const raw = String(value || '0')
  if (raw.endsWith('m')) return Number(raw.slice(0, -1)) / 1000
  return Number(raw) || 0
}

const parseK8sMemGi = value => {
  const raw = String(value || '0')
  const match = raw.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi)?$/)
  if (!match) return 0
  const amount = Number(match[1])
  const unit = match[2] || 'Ki'
  if (unit === 'Gi') return amount
  if (unit === 'Mi') return amount / 1024
  return amount / 1024 / 1024
}

export async function readCloudNodesFromKubeconfig(text = '', fetcher = globalThis.fetch) {
  const source = String(text)
  const summary = parseKubeconfigSummary(source)
  const token = source.match(/token:\s*([^\n]+)/)?.[1]?.trim()

  if (!summary.server) throw new Error('kubeconfig에서 server 주소를 찾지 못했습니다.')
  if (!token) {
    if (summary.hasExecAuth) {
      throw new Error('exec 인증 kubeconfig는 브라우저에서 인증 명령을 실행할 수 없습니다.')
    }
    throw new Error('브라우저 직접 조회에는 정적 token이 포함된 kubeconfig가 필요합니다.')
  }

  const res = await fetcher(`${summary.server.replace(/\/$/, '')}/api/v1/nodes`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Kubernetes API 노드 조회 실패 (${res.status})`)

  const data = await res.json()
  const nodes = (data.items || []).map((item, index) => {
    const labels = item.metadata?.labels || {}
    const isMaster = labels['node-role.kubernetes.io/master'] !== undefined ||
      labels['node-role.kubernetes.io/control-plane'] !== undefined
    const allocatable = item.status?.allocatable || {}
    return {
      id: item.metadata?.uid || `cloud-node-${index + 1}`,
      name: item.metadata?.name || `node-${index + 1}`,
      role: isMaster ? 'master' : 'worker',
      cpu: round(parseK8sCPU(allocatable.cpu), 3),
      mem: round(parseK8sMemGi(allocatable.memory), 3),
    }
  })

  return {
    summary,
    nodes,
    host: {
      cpu: round(nodes.reduce((sum, node) => sum + node.cpu, 0), 3),
      mem: round(nodes.reduce((sum, node) => sum + node.mem, 0), 3),
    },
  }
}

export function runCA(rawClusterInfo) {
  _id = 0
  const clusterInfo = normalizeClusterInfo(rawClusterInfo)
  const { env, host, nodes, source } = clusterInfo
  const issues = []

  const safeHostMem = host.mem * 0.75
  const safeHostCPU = host.cpu * 0.75
  const totalNodeMem = nodes.reduce((sum, node) => sum + node.mem, 0)
  const totalNodeCPU = nodes.reduce((sum, node) => sum + node.cpu, 0)
  const workers = nodes.filter(node => node.role === 'worker')
  const masters = nodes.filter(node => node.role === 'master')
  const checksSingleHostCapacity = env === 'local' || (env === 'vm' && source?.nodeDiscovery !== 'script')
  const isAllocatableInput = (env === 'vm' && source?.nodeDiscovery === 'script') || env === 'cloud'
  const singleControlPlane = workers.length === 0 && masters.length === 1 && nodes.length === 1
  const workloadNodes = checksSingleHostCapacity ? nodes : singleControlPlane ? masters : workers
  const workloadPolicy = singleControlPlane
    ? WORKLOAD_POLICY.singleNodeControlPlane
    : checksSingleHostCapacity
      ? 'single-host-all-nodes'
    : WORKLOAD_POLICY.workersOnly
  const hostCapacityCPU = env === 'local' ? safeHostCPU : host.cpu
  const hostCapacityMem = env === 'local' ? safeHostMem : host.mem

  if (!host.cpu || !host.mem) {
    issues.push(mk(
      CA_SEVERITY.WARNING,
      'CA-00',
      '호스트 CPU/Memory 정보가 비어 있습니다.',
      '환경 감지 또는 스크립트 결과를 다시 확인하세요.'
    ))
  }

  if (nodes.length === 0) {
    issues.push(mk(
      CA_SEVERITY.ERROR,
      'CA-10',
      '노드 구성이 없습니다.',
      '마스터/워커 노드를 최소 1개 이상 입력해야 CA와 RA 계산이 가능합니다.'
    ))
  }

  if (!checksSingleHostCapacity && workers.length === 0 && !singleControlPlane) {
    issues.push(mk(
      CA_SEVERITY.ERROR,
      'CA-11',
      '워커 노드가 없습니다.',
      '사용자 파드를 배치할 워커 노드를 1개 이상 추가하세요.'
    ))
  }

  if (singleControlPlane) {
    issues.push(mk(
      CA_SEVERITY.INFO,
      'CA-12',
      '단일 노드 클러스터로 판단해 control-plane 노드를 파드 배치 대상으로 계산했습니다.',
      '운영 멀티노드 클러스터에서는 워커 노드를 분리하는 구성이 더 안전합니다.'
    ))
  }

  if (checksSingleHostCapacity && host.mem && totalNodeMem > hostCapacityMem) {
    issues.push(mk(
      CA_SEVERITY.ERROR,
      'CA-01',
      `노드 메모리 합산(${fmt(totalNodeMem)}GB)이 ${env === 'local' ? '호스트 안전범위' : '실행 VM 용량'}(${fmt(hostCapacityMem)}GB)를 초과합니다.`,
      '노드 메모리를 줄이거나 워커 노드 수를 줄이세요.'
    ))
  } else if (checksSingleHostCapacity && host.mem && totalNodeMem >= hostCapacityMem * 0.9) {
    issues.push(mk(
      CA_SEVERITY.WARNING,
      'CA-02',
      `노드 메모리 합산(${fmt(totalNodeMem)}GB)이 ${env === 'local' ? '호스트 안전범위' : '실행 VM 용량'}(${fmt(hostCapacityMem)}GB)에 근접합니다.`,
      '로컬/VM 환경에서는 OS 여유 메모리를 남기도록 워커 노드 1개 제거를 검토하세요.'
    ))
  }

  if (checksSingleHostCapacity && host.cpu && totalNodeCPU > hostCapacityCPU) {
    issues.push(mk(
      CA_SEVERITY.ERROR,
      'CA-03',
      `노드 CPU 합산(${fmt(totalNodeCPU)}core)이 ${env === 'local' ? '호스트 안전범위' : '실행 VM 용량'}(${fmt(hostCapacityCPU)}core)를 초과합니다.`,
      '노드 CPU 할당량을 낮추거나 워커 노드 수를 줄이세요.'
    ))
  } else if (checksSingleHostCapacity && host.cpu && totalNodeCPU >= hostCapacityCPU * 0.9) {
    issues.push(mk(
      CA_SEVERITY.WARNING,
      'CA-04',
      `노드 CPU 합산(${fmt(totalNodeCPU)}core)이 ${env === 'local' ? '호스트 안전범위' : '실행 VM 용량'}(${fmt(hostCapacityCPU)}core)에 근접합니다.`,
      '빌드/브라우저/IDE가 함께 실행될 여유 CPU를 남기는 구성이 좋습니다.'
    ))
  }

  masters.forEach(node => {
    if (node.mem * 1024 < SYSTEM_RESERVE.master.mem || node.cpu * 1000 < SYSTEM_RESERVE.master.cpu) {
      issues.push(mk(
        CA_SEVERITY.WARNING,
        'CA-05',
        `${node.name} 마스터 노드 리소스가 시스템 예약치에 가깝습니다.`,
        '마스터 노드는 최소 2core / 4GB 이상을 권장합니다.'
      ))
    }
  })

  if (isAllocatableInput && !checksSingleHostCapacity) {
    issues.push(mk(
      CA_SEVERITY.INFO,
      'CA-09',
      'VM 환경은 물리 호스트 안전범위 검사를 생략했습니다.',
      '마스터 노드에서 조회한 각 노드 Allocatable 기준으로 파드 할당 가능 총량을 계산합니다.'
    ))
  }

  if (checksSingleHostCapacity && env === 'vm') {
    issues.push(mk(
      CA_SEVERITY.INFO,
      'CA-13',
      '수동 입력 VM 구성은 실행 VM 용량을 상한으로 계산했습니다.',
      '노드 합산이 실행 VM 사양을 넘으면 파드 할당 가능 리소스도 잔여 용량으로 제한됩니다.'
    ))
  }

  const invalidNodes = workloadNodes.filter(node => node.cpu <= 0 || node.mem <= 0)
  invalidNodes.forEach(node => {
    issues.push(mk(
      CA_SEVERITY.ERROR,
      'CA-08',
      `${node.name} 노드의 CPU/Memory 값이 비어 있거나 0입니다.`,
      '노드 CPU와 Memory를 0보다 큰 값으로 입력해야 파드 할당 가능 리소스를 계산할 수 있습니다.'
    ))
  })

  const reserveFor = node => {
    if (isAllocatableInput) return { cpu: 0, mem: 0 }
    return SYSTEM_RESERVE[node.role] || SYSTEM_RESERVE.worker
  }

  const rawAvailableCPU = workloadNodes.reduce(
    (sum, node) => {
      const reserve = reserveFor(node)
      return sum + Math.max(0, node.cpu * 1000 - reserve.cpu)
    },
    0
  )
  const rawAvailableMem = workloadNodes.reduce(
    (sum, node) => {
      const reserve = reserveFor(node)
      return sum + Math.max(0, node.mem * 1024 - reserve.mem)
    },
    0
  )
  const singleHostRemainingCPU = Math.max(0, hostCapacityCPU * 1000)
  const singleHostRemainingMem = Math.max(0, hostCapacityMem * 1024)
  const availableCPU = checksSingleHostCapacity
    ? Math.min(rawAvailableCPU, singleHostRemainingCPU)
    : rawAvailableCPU
  const availableMem = checksSingleHostCapacity
    ? Math.min(rawAvailableMem, singleHostRemainingMem)
    : rawAvailableMem

  if (workloadNodes.length > 0 && availableCPU < 500) {
    issues.push(mk(
      CA_SEVERITY.WARNING,
      'CA-06',
      `파드에 사용 가능한 CPU가 ${Math.round(availableCPU)}m로 낮습니다.`,
      '서비스 Request 합산이 500m를 넘으면 스케줄링 실패 가능성이 큽니다.'
    ))
  }

  if (workloadNodes.length > 0 && availableMem < 1024) {
    issues.push(mk(
      CA_SEVERITY.WARNING,
      'CA-07',
      `파드에 사용 가능한 Memory가 ${Math.round(availableMem)}Mi로 낮습니다.`,
      'DB 또는 JVM 서비스를 올릴 예정이면 워커 메모리를 늘리세요.'
    ))
  }

  if (issues.length === 0) {
    issues.push(mk(
      CA_SEVERITY.INFO,
      'CA-OK',
      '현재 노드 구성은 호스트 안전범위 안에 있습니다.',
      '이 가용 리소스를 기준으로 RA 서비스 Request/Limit 계산을 진행할 수 있습니다.'
    ))
  }

  const sortedIssues = issues.sort((a, b) => {
    const rank = { ERROR: 0, WARNING: 1, INFO: 2 }
    return rank[a.severity] - rank[b.severity]
  })

  return {
    issues: sortedIssues,
    hasError: sortedIssues.some(issue => issue.severity === CA_SEVERITY.ERROR),
    availableCPU: Math.max(0, Math.round(availableCPU)),
    availableMem: Math.max(0, Math.round(availableMem)),
    summary: {
      env,
      hostCPU: host.cpu,
      hostMem: host.mem,
      safeHostCPU,
      safeHostMem,
      masterCount: masters.length,
      workerCount: workers.length,
      workloadNodeCount: workloadNodes.length,
      workloadPolicy,
      isAllocatableInput,
      checksSingleHostCapacity,
      totalNodeCPU,
      totalNodeMem,
      rawAvailableCPU: Math.max(0, Math.round(rawAvailableCPU)),
      rawAvailableMem: Math.max(0, Math.round(rawAvailableMem)),
      singleHostRemainingCPU: Math.max(0, Math.round(singleHostRemainingCPU)),
      singleHostRemainingMem: Math.max(0, Math.round(singleHostRemainingMem)),
      availableCPU: Math.max(0, Math.round(availableCPU)),
      availableMem: Math.max(0, Math.round(availableMem)),
    },
  }
}
