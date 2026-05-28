// App-of-Apps 패턴 YAML 생성기

export function genRootApp(controlRepo) {
  const repoUrl = `https://github.com/${controlRepo}`
  return `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root-app
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: ${repoUrl}
    targetRevision: HEAD
    path: apps
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
`
}

export function genUserApp(user) {
  return `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${user.name}-app
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: ${user.name}-project
  source:
    repoURL: ${user.repoUrl}
    targetRevision: HEAD
    path: k8s/overlays/production
  destination:
    server: https://kubernetes.default.svc
    namespace: ${user.namespace}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
`
}

export function genUserProject(user) {
  return `apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: ${user.name}-project
  namespace: argocd
spec:
  description: "GitOps project for ${user.name}"
  sourceRepos:
    - "${user.repoUrl}"
  destinations:
    - namespace: "${user.namespace}"
      server: https://kubernetes.default.svc
  clusterResourceWhitelist:
    - group: ''
      kind: Namespace
  roles:
    - name: ${user.name}-deployer
      description: "Deploy access for ${user.name}"
      policies:
        - p, proj:${user.name}-project:${user.name}-deployer, applications, sync, ${user.name}-project/*, allow
`
}

// 컨트롤 레포에 푸시할 전체 파일 맵 반환
export function buildControlFiles(controlRepo, users) {
  const files = {}
  files['root-app.yaml'] = genRootApp(controlRepo)
  for (const user of users) {
    files[`apps/${user.name}-app.yaml`]     = genUserApp(user)
    files[`apps/${user.name}-project.yaml`] = genUserProject(user)
  }
  return files
}

// 프리뷰용 파일 탭 목록
export function getPreviewTabs(users) {
  const tabs = [{ key: 'root-app.yaml', label: 'root-app.yaml', icon: '⊕' }]
  for (const user of users) {
    tabs.push({ key: `apps/${user.name}-app.yaml`,     label: `${user.name}-app.yaml`,     icon: '▷' })
    tabs.push({ key: `apps/${user.name}-project.yaml`, label: `${user.name}-project.yaml`, icon: '◈' })
  }
  return tabs
}
