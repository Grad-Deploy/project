// ══════════════════════════════════════════════════════
//  Grad-Deploy v2  ·  6대 가드레일 엔진 (순수 함수)
//  RA / GE / PG / NA / VE
// ══════════════════════════════════════════════════════

export const SEVERITY = { ERROR: 'ERROR', WARNING: 'WARNING' }

let _id = 0
const mk = (engine, severity, rule, message, suggestion, field = null) => ({
  id: `${engine}-${rule}-${++_id}`,
  engine, severity, rule, message, suggestion, field,
})

// ── 서비스 템플릿 ──────────────────────────────────────
export const SERVICE_TEMPLATES = {
  'spring-boot': {
    label: 'Spring Boot', icon: '☕',
    cpuReq: '250m', memReq: '512Mi', cpuLim: null, memLim: '1Gi',
    port: 8080, startupFT: 30, startupPS: 10,
    liveness: '/actuator/health', readiness: '/actuator/health/readiness',
    isJVM: true, color: '#22e9a0',
  },
  'node-backend': {
    label: 'Node.js', icon: '⬡',
    cpuReq: '100m', memReq: '256Mi', cpuLim: null, memLim: '512Mi',
    port: 3000, startupFT: 10, startupPS: 5,
    liveness: '/healthz', readiness: '/ready',
    color: '#68d391',
  },
  'python-flask': {
    label: 'Python Flask', icon: '🐍',
    cpuReq: '100m', memReq: '256Mi', cpuLim: null, memLim: '512Mi',
    port: 5000, startupFT: 15, startupPS: 5,
    liveness: '/healthz', readiness: '/ready',
    color: '#fbbf24',
  },
  'react-nginx': {
    label: 'React / Nginx', icon: '⚛',
    cpuReq: '50m', memReq: '128Mi', cpuLim: '200m', memLim: '256Mi',
    port: 80, startupFT: 5, startupPS: 3,
    liveness: '/', readiness: '/',
    color: '#529cff',
  },
  // ── Next.js (SSR/ISR 프론트엔드) ─────────────────────
  // 자체 Node.js 서버(포트 3000)를 사용하며, nginx 정적 파일 서빙과 다름
  // API Routes를 통해 DB 직접 연결 가능 (CONNECTION_RULES 참조)
  // standalone 모드로 빌드하여 경량 Docker 이미지 생성
  'nextjs': {
    label: 'Next.js', icon: '▲',
    cpuReq: '100m', memReq: '256Mi', cpuLim: null, memLim: '512Mi',
    port: 3000, startupFT: 15, startupPS: 5,
    liveness: '/api/health', readiness: '/api/health',
    color: '#e2e8f0',
  },
  // ── 리버스 프록시 전용 Nginx ──────────────────────────
  // 프론트엔드가 없거나 별도 백엔드 앞단에 배치하는 nginx
  // nginx.conf ConfigMap을 통해 upstream 프록시 설정을 주입
  'nginx': {
    label: 'Nginx (Reverse Proxy)', icon: '⬡',
    cpuReq: '50m', memReq: '64Mi', cpuLim: '200m', memLim: '128Mi',
    port: 80, startupFT: 5, startupPS: 3,
    liveness: '/healthz', readiness: '/healthz',
    isNginx: true,   // nginx.conf ConfigMap 마운트 필요 플래그
    color: '#22d3ee',
  },
  mysql: {
    label: 'MySQL', icon: '◎',
    cpuReq: '250m', memReq: '512Mi', cpuLim: '500m', memLim: '1Gi',
    port: 3306, startupFT: 20, startupPS: 10,
    isDB: true, color: '#f97316',
    // httpGet 불가 → exec 방식
    probeExec: ['mysqladmin', 'ping', '-h', 'localhost'],
  },
  postgresql: {
    label: 'PostgreSQL', icon: '⬢',
    cpuReq: '250m', memReq: '512Mi', cpuLim: '500m', memLim: '1Gi',
    port: 5432, startupFT: 20, startupPS: 10,
    isDB: true, color: '#6366f1',
    probeExec: ['pg_isready', '-U', 'postgres'],
  },
  redis: {
    label: 'Redis', icon: '◈',
    cpuReq: '100m', memReq: '128Mi', cpuLim: '200m', memLim: '256Mi',
    port: 6379, startupFT: 10, startupPS: 5,
    isDB: true, color: '#f87171',
    probeExec: ['redis-cli', 'ping'],
  },
  mongodb: {
    label: 'MongoDB', icon: '◉',
    cpuReq: '250m', memReq: '512Mi', cpuLim: '500m', memLim: '2Gi',
    port: 27017, startupFT: 20, startupPS: 10,
    isDB: true, color: '#86efac',
    probeExec: ['mongosh', '--eval', "db.adminCommand('ping')", '--quiet'],
  },
  elasticsearch: {
    label: 'Elasticsearch', icon: '◐',
    cpuReq: '500m', memReq: '1Gi', cpuLim: '1000m', memLim: '2Gi',
    port: 9200, startupFT: 30, startupPS: 10,
    isDB: true, color: '#f59e0b',
    // httpGet으로 /_cluster/health 확인
    probeExec: [
      'sh', '-c',
      'curl -sf http://localhost:9200/_cluster/health?wait_for_status=yellow&timeout=5s || exit 1',
    ],
  },
}

export const ENGINE_META = {
  RA: { label: 'Resource Advisor',   color: '#ffb547' },  // RA-01~04
  GE: { label: 'Guardrail Engine',   color: '#ff5f6d' },  // GE-01~04
  PG: { label: 'Probe Generator',    color: '#b78bff' },  // PG-01~04
  NA: { label: 'Network Analyzer',   color: '#1fe8ff' },  // NA-01~04
  VE: { label: 'Validation Engine',  color: '#22e9a0' },  // VE-03,05,06
}

// ── 파싱 유틸 ──────────────────────────────────────────
const parseMilliCPU = v => {
  if (!v) return null
  if (String(v).endsWith('m')) return parseInt(v)
  return parseFloat(v) * 1000
}

// ── RA — Resource Advisor ──────────────────────────────
export function runRA(services) {
  const issues = []
  services.forEach(svc => {
    const t = SERVICE_TEMPLATES[svc.type] || {}
    if (!svc.cpuReq && !svc.memReq)
      issues.push(mk('RA', SEVERITY.WARNING, 'RA-01',
        `[${svc.name}] CPU/Memory Request 미설정 — BestEffort QoS`,
        `권장값: CPU ${t.cpuReq || '100m'}, Memory ${t.memReq || '256Mi'}`, 'cpuReq'))

    const cr = parseMilliCPU(svc.cpuReq), cl = parseMilliCPU(svc.cpuLim), tr = parseMilliCPU(t.cpuReq)
    if (cr && tr && cr > tr * 3)
      issues.push(mk('RA', SEVERITY.WARNING, 'RA-02',
        `[${svc.name}] CPU Request(${svc.cpuReq})가 권장값의 300% 초과`,
        '클라우드 크레딧 조기 소진 위험. 권장값으로 조정하세요.', 'cpuReq'))
    if (cl && cr && cl < cr * 2)
      issues.push(mk('RA', SEVERITY.WARNING, 'RA-03',
        `[${svc.name}] CPU Limit이 Request의 2배 미만 — CFS Throttling 위험`,
        'Limit을 Request의 최소 2배 이상으로 설정하세요.', 'cpuLim'))

    // RA-04: 멀티 레플리카인데 AntiAffinity 미설정 (kind 멀티 노드 환경)
    const rep = parseInt(svc.replicas) || 1
    if (!t.isDB && rep > 1 && !svc.antiAffinity)
      issues.push(mk('RA', SEVERITY.WARNING, 'RA-04',
        `[${svc.name}] replicas(${rep}) > 1 이지만 AntiAffinity 미설정`,
        'kind 멀티 노드에서 Pod가 같은 노드에 몰릴 수 있습니다. AntiAffinity를 활성화하세요.', 'antiAffinity'))
  })
  return issues
}

// ── GE — Guardrail Engine ──────────────────────────────
export function runGE(services) {
  const issues = []
  services.forEach(svc => {
    const rep = parseInt(svc.replicas) || 1
    const pdb = parseInt(svc.pdbMin)
    if (!isNaN(pdb) && pdb >= rep)
      issues.push(mk('GE', SEVERITY.ERROR, 'GE-01',
        `[${svc.name}] PDB Deadlock: minAvailable(${pdb}) ≥ replicas(${rep})`,
        `노드 드레인 시 Pod 종료 불가. 권장: minAvailable = ${Math.max(1, rep - 1)}`, 'pdbMin'))
    if (svc.hpa && !svc.cpuReq)
      issues.push(mk('GE', SEVERITY.ERROR, 'GE-02',
        `[${svc.name}] HPA + CPU Request 미설정 → HPA 동작 불가`,
        'CPU Request를 설정하세요.', 'cpuReq'))
    if (svc.hpa && !svc.hpaWindow)
      issues.push(mk('GE', SEVERITY.WARNING, 'GE-03',
        `[${svc.name}] HPA Stabilization Window 미설정 — Flapping 위험`,
        'scaleUp: 60s, scaleDown: 300s 적용 권장', 'hpaWindow'))
    if (svc.hpa && rep === 1)
      issues.push(mk('GE', SEVERITY.WARNING, 'GE-04',
        `[${svc.name}] HPA + 단일 Replica — 가용성 위험`,
        'minReplicas: 2 이상을 권장합니다.', 'replicas'))
  })
  return issues
}

// ── PG — Probe Generator ───────────────────────────────
const DB_LV = /\/health\/db|\/actuator\/health\/db/i

export function runPG(services) {
  const issues = []
  services.forEach(svc => {
    const t = SERVICE_TEMPLATES[svc.type] || {}

    // DB 서비스는 exec probe 자동 생성 → httpGet 관련 경고 제외
    if (t.isDB) return

    if (!svc.liveness)
      issues.push(mk('PG', SEVERITY.WARNING, 'PG-01',
        `[${svc.name}] Liveness Probe 미설정`,
        `권장: ${t.liveness || '/healthz'}`, 'liveness'))
    if (!svc.readiness)
      issues.push(mk('PG', SEVERITY.WARNING, 'PG-02',
        `[${svc.name}] Readiness Probe 미설정`,
        '트래픽 수신 준비 전 Service 등록 방지 필요', 'readiness'))
    if (!svc.startupProbe && t.isJVM)
      issues.push(mk('PG', SEVERITY.WARNING, 'PG-03',
        `[${svc.name}] JVM Startup Probe 미설정 — 무한 재시작 위험`,
        `failureThreshold:${t.startupFT}, periodSeconds:${t.startupPS} 자동 주입 권장`, 'startupProbe'))
    if (svc.liveness && DB_LV.test(svc.liveness))
      issues.push(mk('PG', SEVERITY.WARNING, 'PG-04',
        `[${svc.name}] Liveness에 DB 연결 패턴 — 연쇄 재시작 위험`,
        'Liveness: /healthz (내부), Readiness: /ready (외부 포함) 분리', 'liveness'))
  })
  return issues
}

// ── NA — Network Analyzer ──────────────────────────────
function detectCycles(services) {
  const map = {}
  services.forEach(s => { map[s.name] = s.deps || [] })
  const vis = new Set(), stk = new Set(), cycles = []
  const dfs = (n, path) => {
    if (stk.has(n)) { cycles.push([...path, n]); return }
    if (vis.has(n)) return
    vis.add(n); stk.add(n)
    ;(map[n] || []).forEach(d => dfs(d, [...path, n]))
    stk.delete(n)
  }
  services.forEach(s => dfs(s.name, []))
  return cycles
}

export function runNA(services, opts = {}) {
  const issues = []
  if (!opts.netPolicy)
    issues.push(mk('NA', SEVERITY.WARNING, 'NA-01',
      '[Namespace] NetworkPolicy 미설정 — 전체 Pod 간 통신 허용',
      'default-deny 템플릿을 적용하세요.', 'netPolicy'))

  // NA-02: kind/local 환경에서 expose=true인데 ingressPath 미설정
  if (opts.cloud === 'kind' || opts.cloud === 'local') {
    services.forEach(svc => {
      const t = SERVICE_TEMPLATES[svc.type] || {}
      if (svc.expose && !t.isDB && !svc.ingressPath)
        issues.push(mk('NA', SEVERITY.WARNING, 'NA-02',
          `[${svc.name}] kind 환경에서 외부 노출 설정됐지만 Ingress 경로 미설정`,
          `Ingress Path를 입력하세요 (예: /${svc.name}). 미설정 시 /${svc.name} 으로 자동 생성됩니다.`,
          'ingressPath'))
    })
  }

  // NA-03: nginx 서비스가 없는 경우 경고
  // nginx(리버스 프록시) 또는 react-nginx 중 하나는 반드시 있어야 함
  // 외부 트래픽의 단일 진입점 역할을 하며 kind Ingress Controller와 연동됨
  const hasNginx = services.some(s =>
    s.type === 'nginx' || s.type === 'react-nginx'
  )
  if (!hasNginx && services.length > 0)
    issues.push(mk('NA', SEVERITY.WARNING, 'NA-03',
      '[Namespace] Nginx 서비스 없음 — 외부 트래픽 진입점 미확보',
      'nginx(리버스 프록시) 또는 react-nginx 서비스를 추가하세요. ' +
      'kind Ingress Controller는 nginx를 통해 백엔드로 트래픽을 전달합니다.',
      null))

  detectCycles(services).forEach(c =>
    issues.push(mk('NA', SEVERITY.ERROR, 'NA-04',
      `순환 의존성: ${c.join(' → ')}`,
      'depends_on 방향을 재설계하세요.', 'deps'))
  )
  return issues
}

// ── VE — Validation Engine ─────────────────────────────
export function runVE(services, opts = {}) {
  const issues = []
  services.forEach(svc => {
    const t = SERVICE_TEMPLATES[svc.type] || {}
    const img = svc.image || ''
    if (!img || img.endsWith(':latest') || (img && !img.includes(':')))
      issues.push(mk('VE', SEVERITY.WARNING, 'VE-05',
        `[${svc.name}] latest 태그 — 이미지 변경 추적 불가`,
        '${github.sha} 불변 태그 사용 권장', 'image'))
    if (svc.privileged)
      issues.push(mk('VE', SEVERITY.ERROR, 'VE-06',
        `[${svc.name}] Privileged 모드 — 호스트 전체 접근 권한`,
        '반드시 필요한 경우가 아니면 제거하세요.', 'privileged'))

    // VE-03: 클라우드 환경별 StorageClass 미지정 경고
    if (t.isDB && !svc.storageClass) {
      if (opts.cloud === 'aws')
        issues.push(mk('VE', SEVERITY.WARNING, 'VE-03',
          `[${svc.name}] StorageClass 미지정 → PVC Pending 위험 (AWS)`,
          'AWS EKS: gp3 지정 권장. 미지정 시 기본 StorageClass 사용', 'storageClass'))
      else if (opts.cloud === 'gcp')
        issues.push(mk('VE', SEVERITY.WARNING, 'VE-03',
          `[${svc.name}] StorageClass 미지정 → PVC Pending 위험 (GCP)`,
          'GCP GKE: standard-rwo 지정 권장', 'storageClass'))
      // kind / local: standard(hostPath) 자동 사용 → 경고 없음
    }
  })
  return issues
}

// ── 통합 실행 ──────────────────────────────────────────
export function runAllEngines(services, opts = {}) {
  _id = 0
  const all = [
    ...runRA(services),
    ...runGE(services),
    ...runPG(services),
    ...runNA(services, opts),
    ...runVE(services, opts),
  ]
  all.sort((a, b) => (a.severity === 'ERROR' ? 0 : 1) - (b.severity === 'ERROR' ? 0 : 1))
  return {
    issues: all,
    hasError: all.some(i => i.severity === 'ERROR'),
    counts: {
      total: all.length,
      errors: all.filter(i => i.severity === 'ERROR').length,
      warnings: all.filter(i => i.severity === 'WARNING').length,
    },
  }
}
