// ══════════════════════════════════════════════════════
//  Grad-Deploy v2  ·  useStore.js 개선판
//  - propagateEnvVars 통합 (의존성 기반 env 자동 전파)
//  - kind 클러스터 지원 (antiAffinity, ingressPath, kindCfg)
//  - REMOVE_CONNECTION 시 stale env 정리
//
//  ⚠️  secretMode ('plain' | 'sealed') 제거됨
//      Sealed Secrets는 PDF ADR-003 §12 Phase 2 확장 항목
// ══════════════════════════════════════════════════════

import { useReducer, useMemo, useCallback } from 'react'
import { SERVICE_TEMPLATES, runAllEngines } from '../engines/guardrail'
import { propagateEnvVars, validateEnvVars, calcResourceWarnings } from '../utils/envManager'

const uid = () => Math.random().toString(36).slice(2, 9)

export function newService(type = 'spring-boot') {
  const t = SERVICE_TEMPLATES[type] || {}

  // nginx/react-nginx: 외부 트래픽 진입점이므로 expose 기본값 true
  // 이름도 타입별로 명확하게 지정
  const nameMap = {
    'nginx': 'nginx-svc',
    'react-nginx': 'react-nginx-svc',
    'nextjs': 'nextjs-svc',
    'spring-boot': 'spring-svc',
    'node-backend': 'node-svc',
    'python-flask': 'flask-svc',
    'mysql': 'mysql-svc',
    'postgresql': 'postgres-svc',
    'redis': 'redis-svc',
    'mongodb': 'mongo-svc',
    'elasticsearch': 'elastic-svc',
  }
  const defaultName = nameMap[type] || `${type.split('-')[0]}-svc`
  const isNginxType = type === 'nginx' || type === 'react-nginx'
  const isFrontend = isNginxType || type === 'nextjs'

  return {
    id: uid(),
    name: defaultName,
    type,
    image: '',
    port: t.port || 8080,
    replicas: 1,
    cpuReq: t.cpuReq || '100m',
    memReq: t.memReq || '256Mi',
    cpuLim: t.cpuLim || '',
    memLim: t.memLim || '512Mi',
    hpa: false,
    maxRep: 4,
    hpaWindow: false,
    pdbMin: '',
    liveness: t.liveness || '',
    readiness: t.readiness || '',
    startupProbe: t.isJVM || false,
    deps: [],
    env: {},
    expose: isFrontend,   // 프론트엔드(nginx/react-nginx/nextjs)는 기본 expose=true (Ingress 진입점)
    ingressPath: isFrontend ? '/' : '',  // 프론트엔드는 기본 경로 '/'
    antiAffinity: false,
    storageClass: '',
    storageSize: '10Gi',
    privileged: false,
  }
}

const INIT = {
  // nginx는 모든 프로젝트에 필수 — 외부 트래픽 진입점 + kind Ingress 연동
  services: [newService('nginx'), newService('spring-boot'), newService('mysql')],
  ns: 'default',
  proj: 'my-app',
  repo: '',
  cloud: 'kind',       // 기본값을 kind로 변경
  netPolicy: true,

  // kind 클러스터 설정
  kindWorkerCount: 2,          // worker 노드 수
  kindUseLocalRegistry: false, // 로컬 레지스트리 연동
  kindRegistryPort: 5001,      // 로컬 레지스트리 포트

  // 컨테이너 레지스트리
  registry: 'ghcr',
  dockerhubUser: '',
  dockerhubToken: '',

  // GitHub
  pat: '',
  ghUser: null,
  deployMode: 'existing',
  selectedRepo: '',
  newRepoName: '',
  newRepoPrivate: true,
  pushStatus: null,

  // UI
  tab: 'services',
  previewFile: 'manifest',
  expandedSvcIds: {},

  // SSO / Argo CD 연동 (역할2 — SsoSetupSection 에서 set()으로 저장)
  argocdServer: import.meta.env.VITE_DEFAULT_ARGOCD_SERVER || '',   // Argo CD 서버 URL — Tab A/B 공유
  ssoClientId: '',   // OAuth App Client ID (GitHub Variable 으로 등록됨)
  ssoTeams: [],   // [{ team: string, role: 'admin'|'deploy'|'readonly' }]

  // ── ArgoCD 자동 연동 (DeployPanel 4단계) ──────────────
  // 세션 메모리에만 보관되며 새로고침 시 사라짐, GitHub에 push 되지 않음
  argocdUser: import.meta.env.VITE_DEFAULT_ARGOCD_USER || 'admin',  // ArgoCD 로그인 계정 (기본 admin)
  argocdAdminPassword: import.meta.env.VITE_DEFAULT_ARGOCD_PASSWORD || '',       // admin 비밀번호 — argoLogin()으로 토큰 발급에 사용
  argocdToken: import.meta.env.VITE_DEFAULT_ARGOCD_TOKEN || '',       // 직접 토큰 입력 시 우선 사용 (선택)
}


function reducer(s, a) {
  switch (a.type) {
    case 'ADD_SVC': {
      const svc = newService(a.svcType)
      return {
        ...s,
        services: [...s.services, svc],
        expandedSvcIds: { ...s.expandedSvcIds, [svc.id]: true },
      }
    }

    case 'DEL_SVC': {
      const targetSvc = s.services.find(x => x.id === a.id)
      if (!targetSvc) return s

      // nginx/react-nginx는 최소 1개 유지 — NA-03 가드레일 필수 조건
      const isNginxType = targetSvc.type === 'nginx' || targetSvc.type === 'react-nginx'
      const nginxCount = s.services.filter(x =>
        x.type === 'nginx' || x.type === 'react-nginx'
      ).length
      if (isNginxType && nginxCount <= 1) {
        // 마지막 nginx는 삭제 불가 — 상태 변경 없이 반환
        return s
      }

      const { [a.id]: _, ...rest } = s.expandedSvcIds
      const deletedName = targetSvc.name

      // 삭제된 서비스를 다른 서비스의 deps에서도 제거
      const updatedServices = s.services
        .filter(x => x.id !== a.id)
        .map(svc => ({
          ...svc,
          deps: (svc.deps || []).filter(d => d !== deletedName),
        }))

      return { ...s, services: updatedServices, expandedSvcIds: rest }
    }

    case 'UPD_SVC': {
      const prevSvc = s.services.find(x => x.id === a.id)
      const nextSvc = { ...prevSvc, ...a.patch }

      // deps에서 연결이 제거된 서비스를 찾아서
      // 해당 서비스로부터 자동 전파된 env 키를 정리
      // (사용자가 직접 수정한 값은 유지, propagate 생성 키만 제거)
      // → Phase 1에서는 단순히 merge만 하고 stale 정리는 Phase 1.5에서

      return {
        ...s,
        services: s.services.map(x => x.id === a.id ? nextSvc : x),
      }
    }

    case 'TOGGLE_SVC':
      return {
        ...s,
        expandedSvcIds: { ...s.expandedSvcIds, [a.id]: !s.expandedSvcIds[a.id] },
      }

    case 'ADD_MINIBOARD_PRESET': {
      const postgres = {
        id: uid(),
        name: 'postgres-svc',
        type: 'postgresql',
        image: '',
        port: 5432,
        replicas: 1,
        cpuReq: '250m',
        memReq: '512Mi',
        cpuLim: '500m',
        memLim: '1Gi',
        hpa: false,
        maxRep: 4,
        hpaWindow: false,
        pdbMin: '',
        liveness: '',
        readiness: '',
        startupProbe: false,
        deps: [],
        env: {
          POSTGRES_DB: 'board',
          POSTGRES_USER: 'board_user',
          POSTGRES_PASSWORD: 'board_password'
        },
        expose: false,
        ingressPath: '',
        antiAffinity: false,
        storageClass: '',
        storageSize: '10Gi',
        privileged: false
      }

      const backend = {
        id: uid(),
        name: 'backend-svc',
        type: 'node-backend',
        image: '',
        port: 3000,
        replicas: 1,
        cpuReq: '100m',
        memReq: '256Mi',
        cpuLim: '',
        memLim: '512Mi',
        hpa: false,
        maxRep: 4,
        hpaWindow: false,
        pdbMin: '',
        liveness: '/healthz',
        readiness: '/ready',
        startupProbe: false,
        deps: ['postgres-svc'],
        env: {},
        expose: false,
        ingressPath: '/api',
        antiAffinity: false,
        storageClass: '',
        storageSize: '10Gi',
        privileged: false,
        miniBoard: true
      }

      const frontend = {
        id: uid(),
        name: 'frontend-svc',
        type: 'react-nginx',
        image: '',
        port: 80,
        replicas: 1,
        cpuReq: '50m',
        memReq: '128Mi',
        cpuLim: '200m',
        memLim: '256Mi',
        hpa: false,
        maxRep: 4,
        hpaWindow: false,
        pdbMin: '',
        liveness: '/',
        readiness: '/',
        startupProbe: false,
        deps: ['backend-svc'],
        env: {},
        expose: true,
        ingressPath: '/',
        antiAffinity: false,
        storageClass: '',
        storageSize: '10Gi',
        privileged: false,
        miniBoard: true
      }

      const services = [frontend, backend, postgres]
      const expanded = {}
      services.forEach(svc => { expanded[svc.id] = true })

      return {
        ...s,
        services,
        expandedSvcIds: expanded
      }
    }

    case 'SET':
      return { ...s, ...a.patch }

    default:
      return s
  }
}

export function useStore() {
  const [state, dispatch] = useReducer(reducer, INIT, init => {
    const expanded = {}
    init.services.forEach((svc, i) => { expanded[svc.id] = i === 0 })
    return { ...init, expandedSvcIds: expanded }
  })

  // ── 가드레일 엔진 실행 ─────────────────────────────
  const engineResult = useMemo(
    () => runAllEngines(state.services, { netPolicy: state.netPolicy, cloud: state.cloud }),
    [state.services, state.netPolicy, state.cloud]
  )

  // ── 환경변수 전파 (의존성 기반) ──────────────────────
  // propagatedServices: deps 설정을 기반으로 env가 자동 보강된 서비스 목록
  // UI 표시용 - 실제 저장되는 state.services는 사용자 입력값만 가짐
  const propagatedServices = useMemo(
    () => propagateEnvVars(state.services),
    [state.services]
  )

  // ── 환경변수 검증 결과 ────────────────────────────
  const envIssues = useMemo(
    () => validateEnvVars(propagatedServices),
    [propagatedServices]
  )

  // ── 리소스 경고 ────────────────────────────────────
  const resourceWarnings = useMemo(
    () => calcResourceWarnings(state.services),
    [state.services]
  )

  // ── 디스패처 ──────────────────────────────────────
  const set = useCallback(patch => dispatch({ type: 'SET', patch }), [])
  const addSvc = useCallback(svcType => dispatch({ type: 'ADD_SVC', svcType }), [])
  const delSvc = useCallback(id => dispatch({ type: 'DEL_SVC', id }), [])
  const updSvc = useCallback((id, patch) => dispatch({ type: 'UPD_SVC', id, patch }), [])
  const toggleSvc = useCallback(id => dispatch({ type: 'TOGGLE_SVC', id }), [])
  const addMiniBoardPreset = useCallback(() => dispatch({ type: 'ADD_MINIBOARD_PRESET' }), [])

  return {
    state,
    engineResult,
    propagatedServices,  // ← 새로 추가: env가 전파된 서비스
    envIssues,           // ← 새로 추가: 환경변수 검증 결과
    resourceWarnings,    // ← 새로 추가: 리소스 경고
    set,
    addSvc,
    delSvc,
    updSvc,
    toggleSvc,
    addMiniBoardPreset,
  }
}
