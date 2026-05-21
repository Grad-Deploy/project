import { useReducer, useMemo, useCallback } from 'react'
import { SERVICE_TEMPLATES, runAllEngines } from '../engines/guardrail'

const uid = () => Math.random().toString(36).slice(2, 9)

export function newService(type = 'spring-boot') {
  const t = SERVICE_TEMPLATES[type] || {}
  return {
    id: uid(),
    name: `${type.split('-')[0]}-svc`,
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
    expose: false,
    storageClass: '',
    storageSize: '10Gi',
    privileged: false,
  }
}

const INIT = {
  services: [newService('spring-boot'), newService('mysql')],
  ns: 'default',
  proj: 'my-app',
  repo: '',
  cloud: 'local',
  netPolicy: true,

  // 컨테이너 레지스트리
  registry: 'ghcr',          // 'ghcr' | 'dockerhub'
  dockerhubUser: '',         // Docker Hub 사용자명 (registry='dockerhub'일 때)
  dockerhubToken: '',        // Docker Hub Access Token

  // GitHub deploy
  pat: '',
  ghUser: null,
  deployMode: 'existing',
  selectedRepo: '',
  newRepoName: '',
  newRepoPrivate: true,
  pushStatus: null,

  // 멀티유저 GitOps
  controlRepo: '',         // 'owner/repo' 형식의 컨트롤 레포
  multiUsers: [],          // [{ id, name, namespace, repoUrl }]

  // UI state
  tab: 'services',
  previewFile: 'manifest',
  expandedSvcIds: {},      // { [svcId]: boolean } — 카드 열림 상태
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
      const { [a.id]: _, ...rest } = s.expandedSvcIds
      return {
        ...s,
        services: s.services.filter(x => x.id !== a.id),
        expandedSvcIds: rest,
      }
    }
    case 'UPD_SVC':
      return { ...s, services: s.services.map(x => x.id === a.id ? { ...x, ...a.patch } : x) }
    case 'TOGGLE_SVC':
      return { ...s, expandedSvcIds: { ...s.expandedSvcIds, [a.id]: !s.expandedSvcIds[a.id] } }
    case 'ADD_MULTI_USER': {
      const u = { id: uid(), name: '', namespace: '', repoUrl: '' }
      return { ...s, multiUsers: [...s.multiUsers, u] }
    }
    case 'DEL_MULTI_USER':
      return { ...s, multiUsers: s.multiUsers.filter(u => u.id !== a.id) }
    case 'UPD_MULTI_USER':
      return { ...s, multiUsers: s.multiUsers.map(u => u.id === a.id ? { ...u, ...a.patch } : u) }
    case 'SET':
      return { ...s, ...a.patch }
    default:
      return s
  }
}

export function useStore() {
  const [state, dispatch] = useReducer(reducer, INIT, init => {
    // 초기 서비스들의 expanded 상태 설정 (첫 번째만 열림)
    const expanded = {}
    init.services.forEach((svc, i) => { expanded[svc.id] = i === 0 })
    return { ...init, expandedSvcIds: expanded }
  })

  const engineResult = useMemo(
    () => runAllEngines(state.services, { netPolicy: state.netPolicy, cloud: state.cloud }),
    [state.services, state.netPolicy, state.cloud]
  )

  const set           = useCallback(patch => dispatch({ type: 'SET', patch }), [])
  const addSvc        = useCallback(svcType => dispatch({ type: 'ADD_SVC', svcType }), [])
  const delSvc        = useCallback(id => dispatch({ type: 'DEL_SVC', id }), [])
  const updSvc        = useCallback((id, patch) => dispatch({ type: 'UPD_SVC', id, patch }), [])
  const toggleSvc     = useCallback(id => dispatch({ type: 'TOGGLE_SVC', id }), [])
  const addMultiUser  = useCallback(() => dispatch({ type: 'ADD_MULTI_USER' }), [])
  const delMultiUser  = useCallback(id => dispatch({ type: 'DEL_MULTI_USER', id }), [])
  const updMultiUser  = useCallback((id, patch) => dispatch({ type: 'UPD_MULTI_USER', id, patch }), [])

  return { state, engineResult, set, addSvc, delSvc, updSvc, toggleSvc, addMultiUser, delMultiUser, updMultiUser }
}
