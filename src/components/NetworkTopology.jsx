import { useMemo, useState, useCallback } from 'react'
import { SERVICE_TEMPLATES } from '../engines/guardrail'

// ── 레이아웃 계산 (계층 기반) ────────────────────────────
function buildLayout(services) {
  if (!services.length) return { nodes: [], edges: [] }

  // 위상 정렬로 계층 결정
  const depMap = {}
  services.forEach(s => { depMap[s.name] = s.deps || [] })

  // 진입 차수 계산
  const inDeg = {}
  services.forEach(s => { inDeg[s.name] = 0 })
  services.forEach(s => {
    ;(s.deps || []).forEach(dep => {
      if (inDeg[dep] !== undefined) inDeg[dep]++
    })
  })

  // BFS로 계층 배정
  const layers = []
  const layerOf = {}
  let queue = services.filter(s => inDeg[s.name] === 0).map(s => s.name)

  while (queue.length) {
    layers.push([...queue])
    queue.forEach((name, i) => { layerOf[name] = layers.length - 1 })
    const next = []
    queue.forEach(name => {
      services.forEach(s => {
        if ((s.deps || []).includes(name)) {
          inDeg[s.name]--
          if (inDeg[s.name] === 0) next.push(s.name)
        }
      })
    })
    queue = [...new Set(next)]
  }

  // 계층 미배정(순환 등) 처리
  services.forEach(s => {
    if (layerOf[s.name] === undefined) {
      layerOf[s.name] = layers.length
      if (!layers[layers.length]) layers.push([])
      layers[layers.length - 1].push(s.name)
    }
  })

  // 노드 좌표 계산
  const W = 130, H = 64, GAP_X = 60, GAP_Y = 44
  const totalLayers = layers.length

  const nodes = services.map(svc => {
    const layer = layerOf[svc.name] ?? 0
    const layerNodes = layers[layer] || [svc.name]
    const posInLayer = layerNodes.indexOf(svc.name)
    const layerCount = layerNodes.length

    const x = layer * (W + GAP_X) + GAP_X
    const totalH = layerCount * H + (layerCount - 1) * GAP_Y
    const startY = (500 - totalH) / 2  // 컨테이너 높이 500 기준
    const y = startY + posInLayer * (H + GAP_Y)

    const t = SERVICE_TEMPLATES[svc.type] || {}
    return { id: svc.name, svc, x, y, w: W, h: H, color: t.color || '#529cff', layer, icon: t.icon || '◻' }
  })

  // 엣지
  const edges = []
  services.forEach(svc => {
    ;(svc.deps || []).forEach(dep => {
      const src = nodes.find(n => n.id === svc.name)
      const tgt = nodes.find(n => n.id === dep)
      if (src && tgt) edges.push({ id: `${dep}->${svc.name}`, src: tgt, tgt: src })
    })
  })

  // SVG 전체 크기
  const maxX = Math.max(...nodes.map(n => n.x + n.w)) + GAP_X
  const maxY = Math.max(...nodes.map(n => n.y + n.h)) + GAP_Y
  return { nodes, edges, svgW: Math.max(maxX, 300), svgH: Math.max(maxY, 200) }
}

// 커브 경로
function edgePath(src, tgt, srcNode, tgtNode) {
  const x1 = srcNode.x + srcNode.w
  const y1 = srcNode.y + srcNode.h / 2
  const x2 = tgtNode.x
  const y2 = tgtNode.y + tgtNode.h / 2
  const cx = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`
}

export default function NetworkTopology({ services, engineIssues = [] }) {
  const [hovered, setHovered] = useState(null)
  const { nodes, edges, svgW, svgH } = useMemo(() => buildLayout(services), [services])

  // 순환 의존성 엣지 표시
  const cycleEdges = new Set(
    engineIssues
      .filter(i => i.rule === 'NA-04')
      .flatMap(i => {
        const parts = i.message.split(': ')[1]?.split(' → ') || []
        const result = []
        for (let j = 0; j < parts.length - 1; j++)
          result.push(`${parts[j]}->${parts[j + 1]}`)
        return result
      })
  )

  if (!services.length) {
    return (
      <div style={{
        height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--t3)', fontSize: 12,
        border: '1px dashed var(--border)', borderRadius: 'var(--r2)',
      }}>
        서비스를 추가하면 토폴로지가 표시됩니다
      </div>
    )
  }

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 'var(--r2)',
      background: 'var(--bg1)',
      overflow: 'auto',
      position: 'relative',
    }}>
      {/* 헤더 */}
      <div style={{
        padding: '8px 14px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontSize: 10, color: 'var(--blue)', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          Network Topology
        </span>
        <span style={{ fontSize: 10, color: 'var(--t3)' }}>
          {nodes.length} services · {edges.length} connections
        </span>
      </div>

      {/* SVG */}
      <svg
        width={svgW}
        height={svgH}
        style={{ display: 'block', minWidth: '100%' }}
        viewBox={`0 0 ${svgW} ${svgH}`}
      >
        <defs>
          {/* 화살표 마커 */}
          <marker id="arrow-normal" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="rgba(82,156,255,0.5)" />
          </marker>
          <marker id="arrow-cycle" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="var(--red)" />
          </marker>
          {/* 글로우 필터 */}
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          {/* 그리드 패턴 */}
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(82,156,255,0.04)" strokeWidth="0.5" />
          </pattern>
        </defs>

        {/* 배경 그리드 */}
        <rect width={svgW} height={svgH} fill="url(#grid)" />

        {/* 엣지 */}
        {edges.map(e => {
          const isCycle = cycleEdges.has(e.id)
          const isHov = hovered === e.src.id || hovered === e.tgt.id
          return (
            <path
              key={e.id}
              d={edgePath(e.src.id, e.tgt.id, e.src, e.tgt)}
              fill="none"
              stroke={isCycle ? 'var(--red)' : isHov ? 'var(--blue)' : 'rgba(82,156,255,0.25)'}
              strokeWidth={isCycle ? 2 : isHov ? 1.5 : 1}
              strokeDasharray={isCycle ? '5,3' : undefined}
              markerEnd={`url(#arrow-${isCycle ? 'cycle' : 'normal'})`}
              style={{ transition: 'stroke .2s, stroke-width .2s' }}
            />
          )
        })}

        {/* 노드 */}
        {nodes.map(node => {
          const isHov = hovered === node.id
          const hasIssue = engineIssues.some(i => i.message.includes(`[${node.id}]`))
          const isError = engineIssues.some(i => i.message.includes(`[${node.id}]`) && i.severity === 'ERROR')
          const t = SERVICE_TEMPLATES[node.svc.type] || {}

          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered(null)}
              style={{ cursor: 'pointer' }}
            >
              {/* 그림자/글로우 */}
              {isHov && (
                <rect
                  x={-3} y={-3} width={node.w + 6} height={node.h + 6}
                  rx={10} ry={10}
                  fill="none"
                  stroke={node.color}
                  strokeWidth={1.5}
                  opacity={0.4}
                  filter="url(#glow)"
                />
              )}

              {/* 카드 배경 */}
              <rect
                width={node.w} height={node.h} rx={8} ry={8}
                fill={isHov ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.04)'}
                stroke={isError ? 'rgba(248,95,109,0.6)' : hasIssue ? 'rgba(255,181,71,0.5)' : isHov ? node.color : 'rgba(82,156,255,0.2)'}
                strokeWidth={isHov ? 1.5 : 1}
                style={{ transition: 'all .2s' }}
              />

              {/* 좌측 컬러 바 */}
              <rect
                x={0} y={0} width={4} height={node.h}
                rx={8} ry={8}
                fill={node.color}
                opacity={0.8}
              />

              {/* 아이콘 */}
              <text
                x={20} y={node.h / 2 + 5}
                fontSize={18}
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {node.icon}
              </text>

              {/* 서비스명 */}
              <text
                x={36} y={node.h / 2 - 8}
                fontSize={11} fontWeight={600}
                fill="var(--t1)"
                fontFamily="var(--mono)"
              >
                {node.id.length > 14 ? node.id.slice(0, 13) + '…' : node.id}
              </text>

              {/* 타입 */}
              <text
                x={36} y={node.h / 2 + 8}
                fontSize={9} fill="var(--t3)"
                fontFamily="var(--mono)"
              >
                {t.label || node.svc.type}
              </text>

              {/* 포트 */}
              <text
                x={node.w - 8} y={node.h / 2 + 8}
                fontSize={9} fill="var(--t3)"
                textAnchor="end"
                fontFamily="var(--mono)"
              >
                :{node.svc.port || t.port || '?'}
              </text>

              {/* 이슈 뱃지 */}
              {isError && (
                <circle cx={node.w - 8} cy={8} r={6} fill="var(--red)" />
              )}
              {!isError && hasIssue && (
                <circle cx={node.w - 8} cy={8} r={6} fill="var(--amber)" />
              )}
              {(isError || hasIssue) && (
                <text
                  x={node.w - 8} y={8}
                  fontSize={8} fontWeight={700}
                  fill="white" textAnchor="middle" dominantBaseline="middle"
                  fontFamily="var(--mono)"
                >
                  {isError ? '✕' : '⚠'}
                </text>
              )}

              {/* 호버 시 replicas 표시 */}
              {isHov && (
                <text
                  x={36} y={node.h - 8}
                  fontSize={9} fill={node.color}
                  fontFamily="var(--mono)"
                  opacity={0.8}
                >
                  replicas: {node.svc.replicas || 1}{node.svc.hpa ? ' (HPA)' : ''}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      {/* 범례 */}
      <div style={{
        padding: '8px 14px',
        borderTop: '1px solid var(--border)',
        display: 'flex', gap: 16, flexWrap: 'wrap',
      }}>
        {[
          { color: 'rgba(82,156,255,0.5)', label: '정상 연결', dash: false },
          { color: 'var(--red)',           label: '순환 의존성', dash: true },
          { color: 'var(--red)',           label: 'ERROR', dot: true },
          { color: 'var(--amber)',         label: 'WARNING', dot: true },
        ].map((item, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--t3)' }}>
            {item.dot ? (
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: item.color }} />
            ) : (
              <svg width={20} height={8}>
                <line
                  x1={0} y1={4} x2={20} y2={4}
                  stroke={item.color} strokeWidth={1.5}
                  strokeDasharray={item.dash ? '4,2' : undefined}
                />
              </svg>
            )}
            {item.label}
          </div>
        ))}
      </div>
    </div>
  )
}
