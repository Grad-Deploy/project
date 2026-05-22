// ══════════════════════════════════════════════════════
//  Grad-Deploy v2  ·  K8s 매니페스트 생성기
//  - kind 클러스터 지원 (Ingress·AntiAffinity·LocalRegistry)
//  - ConfigMap / Secret 파일 분리 (envManager 연동)
//  - buildAllFiles: 전체 파일 맵 빌드 (DeployPanel 호출용)
//  - AppProject / ResourceQuota / LimitRange 자동 생성
//
//  클러스터 환경별 동작 분기:
//    cloud='kind'  → Ingress(nginx), ClusterIP, hostPath StorageClass
//    cloud='local' → Minikube (기존 동작 유지)
//    cloud='aws'   → LoadBalancer, gp3 StorageClass
//    cloud='gcp'   → LoadBalancer, standard-rwo StorageClass
// ══════════════════════════════════════════════════════

import { SERVICE_TEMPLATES } from '../engines/guardrail'
import { buildFileMap as envBuildFileMap } from '../utils/envManager'

// ── 클러스터 환경별 StorageClass 기본값 ──────────────
const STORAGE_CLASS_DEFAULT = {
  kind:  'standard',    // kind 기본 (hostPath provisioner)
  local: 'standard',    // Minikube 기본
  aws:   'gp3',         // AWS EKS 권장
  gcp:   'standard-rwo', // GCP GKE 권장
}

// ── probe 헬퍼 ────────────────────────────────────────
function execProbeYaml(cmd, periodSeconds, failureThreshold) {
  const cmdLines = cmd.map(c => `              - "${c}"`).join('\n')
  return `exec:
              command:
${cmdLines}
            failureThreshold: ${failureThreshold}
            periodSeconds: ${periodSeconds}`
}

function httpProbeYaml(path, port, periodSeconds, failureThreshold) {
  return `httpGet:
              path: ${path}
              port: ${port}
            periodSeconds: ${periodSeconds}
            failureThreshold: ${failureThreshold}`
}

// ── Deployment / StatefulSet ──────────────────────────
function genDeployment(svc, ns, cloud = 'kind') {
  const t = SERVICE_TEMPLATES[svc.type] || {}
  const isDB = !!t.isDB
  const kind = isDB ? 'StatefulSet' : 'Deployment'
  const port = svc.port || t.port || 8080
  const img = svc.image || `${svc.name}:latest`
  const cpuR = svc.cpuReq || t.cpuReq || '100m'
  const memR = svc.memReq || t.memReq || '256Mi'
  const memL = svc.memLim || t.memLim || '512Mi'
  const cpuL = svc.cpuLim || t.cpuLim
  const replicas = parseInt(svc.replicas) || 1

  let startupProbe, livenessProbe, readinessProbe

  if (isDB && t.probeExec) {
    startupProbe = execProbeYaml(t.probeExec, t.startupPS || 5, t.startupFT || 10)
    livenessProbe = execProbeYaml(t.probeExec, 30, 3)
    readinessProbe = execProbeYaml(t.probeExec, 10, 3)
  } else {
    const lv = svc.liveness || t.liveness || '/healthz'
    const rd = svc.readiness || t.readiness || '/ready'
    startupProbe = svc.startupProbe
      ? httpProbeYaml(lv, port, t.startupPS || 5, t.startupFT || 30)
      : null
    livenessProbe = httpProbeYaml(lv, port, 30, 3)
    readinessProbe = httpProbeYaml(rd, port, 10, 3)
  }

  const securityCtx = isDB
    ? `runAsUser: 999`
    : `runAsNonRoot: true\n        runAsUser: 1000`

  // ── AntiAffinity: replicas > 1 이거나 사용자가 명시적으로 활성화한 경우
  // kind 멀티 노드에서 Pod를 서로 다른 노드에 분산시킴
  const useAntiAffinity = !isDB && (svc.antiAffinity || replicas > 1)
  const affinityBlock = useAntiAffinity ? `
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: ${svc.name}
                topologyKey: kubernetes.io/hostname` : ''

  // ── StorageClass: 사용자 지정 > 환경별 기본값
  const scName = svc.storageClass || STORAGE_CLASS_DEFAULT[cloud] || 'standard'

  // ── nginx / react-nginx: nginx.conf ConfigMap 볼륨 마운트
  // nginx.conf는 별도 ConfigMap({svc.name}-nginx-conf)으로 관리
  const isNginxType = (svc.type === 'nginx' || svc.type === 'react-nginx')
  const nginxVolumeMount = isNginxType ? `
          volumeMounts:
            - name: nginx-conf
              mountPath: /etc/nginx/conf.d
              readOnly: true` : ''
  const nginxVolume = isNginxType ? `
      volumes:
        - name: nginx-conf
          configMap:
            name: ${svc.name}-nginx-conf` : ''

  return `apiVersion: apps/v1
kind: ${kind}
metadata:
  name: ${svc.name}
  namespace: ${ns}
  labels:
    app: ${svc.name}
    app.kubernetes.io/managed-by: grad-deploy
spec:
  ${isDB ? `serviceName: ${svc.name}` : `replicas: ${replicas}`}
  selector:
    matchLabels:
      app: ${svc.name}
  template:
    metadata:
      labels:
        app: ${svc.name}
    spec:
      securityContext:
        ${securityCtx}${affinityBlock}${nginxVolume}
      containers:
        - name: ${svc.name}
          image: "${img}"
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: ${port}
          resources:
            requests:
              cpu: "${cpuR}"
              memory: "${memR}"
            limits:
              ${cpuL ? `cpu: "${cpuL}"\n              ` : ''}memory: "${memL}"
          envFrom:
            - configMapRef:
                name: ${svc.name}-config
            - secretRef:
                name: ${svc.name}-secret
                optional: true${nginxVolumeMount}
${startupProbe ? `          startupProbe:
            ${startupProbe}
` : ''}          livenessProbe:
            ${livenessProbe}
          readinessProbe:
            ${readinessProbe}${isDB ? `
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: "${scName}"
        resources:
          requests:
            storage: ${svc.storageSize || '10Gi'}` : ''}`
}

// ── Service ───────────────────────────────────────────
function genService(svc, ns, cloud = 'kind') {
  const t = SERVICE_TEMPLATES[svc.type] || {}
  const port = svc.port || t.port || 8080

  // kind / local: LoadBalancer 미지원 → ClusterIP 고정
  // expose=true인 경우 Ingress로 처리 (genIngress 참조)
  // aws / gcp: LoadBalancer 사용 가능
  const svcType = t.isDB
    ? 'clusterIP: None'   // StatefulSet headless — 소문자 clusterIP (K8s API 규격)
    : (svc.expose && (cloud === 'aws' || cloud === 'gcp'))
      ? 'type: LoadBalancer'
      : 'type: ClusterIP'

  return `apiVersion: v1
kind: Service
metadata:
  name: ${svc.name}
  namespace: ${ns}
  labels:
    app: ${svc.name}
    app.kubernetes.io/managed-by: grad-deploy
spec:
  ${svcType}
  selector:
    app: ${svc.name}
  ports:
    - port: ${port}
      targetPort: ${port}`
}

// ── HPA ───────────────────────────────────────────────
function genHPA(svc, ns) {
  if (!svc.hpa) return null
  const min = Math.max(2, parseInt(svc.replicas) || 2)
  return `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${svc.name}-hpa
  namespace: ${ns}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${svc.name}
  minReplicas: ${min}
  maxReplicas: ${svc.maxRep || 10}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300`
}

// ── nginx.conf ConfigMap 생성 ─────────────────────────
// nginx / react-nginx 서비스에 대해 자동 생성
// deps 목록을 읽어 백엔드 upstream 프록시 설정을 자동으로 구성
export function genNginxConf(svc, services, ns) {
  const t = SERVICE_TEMPLATES[svc.type] || {}
  if (svc.type !== 'nginx' && svc.type !== 'react-nginx') return null

  // nginx가 프록시할 백엔드 서비스 목록 (deps 기반)
  const backends = (svc.deps || [])
    .map(depName => {
      const dep = services.find(s => s.name === depName)
      if (!dep) return null
      const dt = SERVICE_TEMPLATES[dep.type] || {}
      // DB 서비스는 nginx 프록시 대상이 아님
      if (dt.isDB) return null
      const depPort = dep.port || dt.port || 8080
      // ingressPath가 있으면 그 경로로, 없으면 /서비스명 경로로 프록시
      const proxyPath = dep.ingressPath || `/${dep.name}`
      return { name: dep.name, port: depPort, path: proxyPath }
    })
    .filter(Boolean)

  // react-nginx: 정적 파일 서빙 + 백엔드 API 프록시
  // nginx(리버스 프록시): 백엔드 upstream 프록시만
  const isReactNginx = svc.type === 'react-nginx'

  // upstream 블록 (deps가 있을 때만)
  const upstreams = backends.map(b => `
    upstream ${b.name}_upstream {
        server ${b.name}.${ns}.svc.cluster.local:${b.port};
    }`).join('\n')

  // location 블록 — 백엔드 API 프록시
  const proxyLocations = backends.map(b => `
        # ${b.name} 백엔드 프록시
        location ${b.path} {
            proxy_pass http://${b.name}_upstream;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_read_timeout 60s;
            proxy_connect_timeout 10s;
        }`).join('\n')

  // healthz 엔드포인트 (Liveness/Readiness Probe 용)
  const healthzLocation = `
        location /healthz {
            access_log off;
            return 200 "ok";
            add_header Content-Type text/plain;
        }`

  // react-nginx: 정적 파일 루트 + SPA fallback
  const staticLocation = isReactNginx ? `
        location / {
            root /usr/share/nginx/html;
            index index.html;
            try_files $uri $uri/ /index.html;  # SPA React Router fallback
        }` : `
        location / {
            return 404;
        }`

  const nginxConf = `# Grad-Deploy 자동 생성 — ${svc.name} nginx.conf
# 서비스 타입: ${t.label}
# 프록시 대상: ${backends.length > 0 ? backends.map(b => b.name).join(', ') : '없음 (정적 파일 서빙만)'}
${upstreams}

server {
    listen 80;
    server_name _;

    # 요청 크기 제한
    client_max_body_size 10m;

    # 압축
    gzip on;
    gzip_types text/plain text/css application/json application/javascript;
${proxyLocations}${staticLocation}${healthzLocation}
}`

  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${svc.name}-nginx-conf
  namespace: ${ns}
  labels:
    app: ${svc.name}
    app.kubernetes.io/managed-by: grad-deploy
data:
  default.conf: |
${nginxConf.split('\n').map(l => `    ${l}`).join('\n')}`
}

// ── Ingress (kind / Nginx Ingress Controller) ─────────
// kind에서 expose=true 서비스를 외부에 노출할 때 사용
// Nginx Ingress Controller 설치 필요:
//   kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
export function genIngress(services, ns, cloud = 'kind') {
  // expose=true이고 DB가 아닌 서비스만 대상
  const exposedSvcs = services.filter(svc => {
    const t = SERVICE_TEMPLATES[svc.type] || {}
    return svc.expose && !t.isDB
  })
  if (!exposedSvcs.length) return null

  // kind / local 환경에서만 Ingress 생성
  // aws / gcp는 LoadBalancer Service로 처리됨
  if (cloud !== 'kind' && cloud !== 'local') return null

  const rules = exposedSvcs.map(svc => {
    const t = SERVICE_TEMPLATES[svc.type] || {}
    const port = svc.port || t.port || 8080
    // ingressPath가 없으면 서비스명 기반 경로 자동 생성
    const path = svc.ingressPath || `/${svc.name}`
    return `  - http:
      paths:
        - path: ${path}
          pathType: Prefix
          backend:
            service:
              name: ${svc.name}
              port:
                number: ${port}`
  }).join('\n')

  return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: grad-deploy-ingress
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: grad-deploy
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
spec:
  ingressClassName: nginx
  rules:
${rules}`
}

// ── kind 클러스터 설정 파일 생성 ──────────────────────
// kind create cluster --config kind-config.yaml 으로 사용
export function genKindConfig(cfg = {}) {
  const {
    workerCount = 2,           // worker 노드 수 (멀티 노드 AntiAffinity 테스트용)
    useLocalRegistry = true,   // 로컬 레지스트리 연동 여부
    registryPort = 5001,       // 로컬 레지스트리 포트
    exposeIngress = true,      // Ingress용 포트 매핑 여부
  } = cfg

  const workers = Array.from({ length: workerCount }, (_, i) => `  - role: worker`).join('\n')

  // extraPortMappings와 containerdConfigPatches는 control-plane 노드 항목 하위에 있어야 함
  // YAML 들여쓰기: nodes 배열 항목이 '  - role: ...' (2칸) 이므로
  // 하위 필드는 '    ' (4칸) 들여쓰기
  const ingressPatch = exposeIngress ? `
    # Nginx Ingress Controller를 위한 포트 매핑
    extraPortMappings:
      - containerPort: 80
        hostPort: 80
        protocol: TCP
      - containerPort: 443
        hostPort: 443
        protocol: TCP` : ''

  const registryPatch = useLocalRegistry ? `
    # 로컬 레지스트리 연동 (kind load docker-image 없이 push/pull 가능)
    containerdConfigPatches:
      - |-
        [plugins."io.containerd.grpc.v1.cri".registry.mirrors."localhost:${registryPort}"]
          endpoint = ["http://kind-registry:${registryPort}"]` : ''

  return `# kind 클러스터 설정 — Grad-Deploy v2
# 사용법: kind create cluster --name grad-deploy --config kind-config.yaml
#
# 사전 요구사항:
#   brew install kind  (macOS) / choco install kind  (Windows)
#   Docker Desktop 실행 중

kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4

nodes:
  - role: control-plane${ingressPatch}${registryPatch}
${workers}
`
}

// ── 로컬 레지스트리 셋업 스크립트 생성 ───────────────
// kind 클러스터에 로컬 Docker 레지스트리를 연동하는 bash 스크립트
// GitHub Actions 없이 로컬 이미지를 직접 클러스터에 주입할 수 있음
export function genLocalRegistryScript(cfg = {}) {
  const {
    registryPort = 5001,
    clusterName = 'grad-deploy',
  } = cfg

  return `#!/usr/bin/env bash
# ══════════════════════════════════════════════════════
#  Grad-Deploy v2 — kind 로컬 레지스트리 셋업
#  실행: bash scripts/setup-kind-registry.sh
# ══════════════════════════════════════════════════════
set -euo pipefail

REGISTRY_NAME="kind-registry"
REGISTRY_PORT="${registryPort}"
CLUSTER_NAME="${clusterName}"

# 1. 레지스트리 컨테이너 실행 (없으면 새로 생성)
if [ "\$(docker inspect -f '{{.State.Running}}' "\${REGISTRY_NAME}" 2>/dev/null)" != "true" ]; then
  echo ">> 로컬 레지스트리 시작 (localhost:\${REGISTRY_PORT})"
  docker run -d --restart=always -p "127.0.0.1:\${REGISTRY_PORT}:5000" \\
    --name "\${REGISTRY_NAME}" registry:2
else
  echo ">> 레지스트리 이미 실행 중"
fi

# 2. kind 클러스터 생성 (없으면)
if ! kind get clusters 2>/dev/null | grep -q "\${CLUSTER_NAME}"; then
  echo ">> kind 클러스터 생성: \${CLUSTER_NAME}"
  kind create cluster --name "\${CLUSTER_NAME}" --config kind-config.yaml
else
  echo ">> 클러스터 '\${CLUSTER_NAME}' 이미 존재"
fi

# 3. 레지스트리를 kind 네트워크에 연결
docker network connect "kind" "\${REGISTRY_NAME}" 2>/dev/null || true

# 4. 레지스트리 ConfigMap 등록 (kubelet이 mirror를 인식하도록)
kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:\${REGISTRY_PORT}"
    help: "https://kind.sigs.k8s.io/docs/user/local-registry/"
EOF

echo ""
echo ">> 셋업 완료!"
echo ">> 이미지 빌드 & 푸시 예시:"
echo "   docker build -t localhost:\${REGISTRY_PORT}/my-app:latest ."
echo "   docker push localhost:\${REGISTRY_PORT}/my-app:latest"
echo "   # kind 클러스터에서 localhost:\${REGISTRY_PORT}/my-app:latest 로 pull 가능"
`
}

// ── Nginx Ingress Controller 설치 안내 ConfigMap ─────
// kubectl apply 후 사용자가 참조할 수 있도록 README로 생성
// proj 파라미터: buildAllFiles의 overlayDir 경로와 일치시키기 위해 추가
export function genIngressSetupReadme(cloud = 'kind', proj = 'my-app') {
  if (cloud !== 'kind' && cloud !== 'local') return null
  // 신 경로: k8s/projects/<proj>/overlays/production/ingress.yaml
  const ingressPath = `k8s/projects/${proj}/overlays/production/ingress.yaml`
  return `# Nginx Ingress Controller 설치 안내

## kind 전용 설치 (extraPortMappings 필요)

\`\`\`bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml

# 설치 완료 대기
kubectl wait --namespace ingress-nginx \\
  --for=condition=ready pod \\
  --selector=app.kubernetes.io/component=controller \\
  --timeout=90s
\`\`\`

## 접속 확인

kind-config.yaml의 extraPortMappings에 hostPort:80을 매핑했으면
http://localhost/{path} 로 접속 가능합니다.

## 서비스별 Ingress 경로

Grad-Deploy가 자동 생성한 \`${ingressPath}\`을 확인하세요.
`
}

// ── NetworkPolicy ────────────────────────────────────
export function genNetworkPolicies(services, ns) {
  const parts = [
    `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: ${ns}
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]`,
    `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: ${ns}
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - ports:
        - protocol: UDP
          port: 53`,
  ]
  services.forEach(svc => {
    if (!(svc.deps || []).length) return
    const port = (SERVICE_TEMPLATES[svc.type] || {}).port || 8080
    parts.push(`apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-${svc.name}-ingress
  namespace: ${ns}
spec:
  podSelector:
    matchLabels:
      app: ${svc.name}
  policyTypes: [Ingress]
  ingress:
    - from:
${svc.deps.map(d => `      - podSelector:\n          matchLabels:\n            app: ${d}`).join('\n')}
      ports:
        - port: ${port}`)
  })
  return parts.join('\n---\n')
}

// ── GitHub Actions ────────────────────────────────────
export function genGitHubActions(services, cfg = {}) {
  const {
    proj = 'my-app',
    ns = 'default',
    registry = 'ghcr',
    dockerhubUser = '',
  } = cfg

  // ── CI 내부에서 참조하는 kustomization 경로 ──────────
  // buildAllFiles·buildFileMap의 overlayDir과 반드시 일치해야 함
  const overlayDir = ['k8s', 'projects', proj, 'overlays', 'production'].join('/')

  const isGHCR = registry === 'ghcr'
  const imageNameOf = name => name.replace(/-svc$/, '-service-v2')
  const imagePath = svcName => isGHCR
    ? `ghcr.io/\${{ github.repository_owner }}/${imageNameOf(svcName)}`
    : `docker.io/${dockerhubUser || '${{ secrets.DOCKERHUB_USERNAME }}'}/${imageNameOf(svcName)}`

  const loginBlock = isGHCR
    ? [
        `      - name: Login to GHCR`,
        `        uses: docker/login-action@v3`,
        `        with:`,
        `          registry: ghcr.io`,
        `          username: \${{ github.actor }}`,
        `          password: \${{ secrets.GITHUB_TOKEN }}`,
      ].join('\n')
    : [
        `      - name: Login to Docker Hub`,
        `        uses: docker/login-action@v3`,
        `        with:`,
        `          username: \${{ secrets.DOCKERHUB_USERNAME }}`,
        `          password: \${{ secrets.DOCKERHUB_TOKEN }}`,
      ].join('\n')

  // 앱 서비스만 빌드 (DB는 공식 이미지 사용)
  const appServices = services.filter(s => !(SERVICE_TEMPLATES[s.type] || {}).isDB)

  const buildJobs = appServices.map(svc => {
    const imgPath = imagePath(svc.name)
    // Next.js: NEXT_PUBLIC_ 변수를 Docker build-arg로 전달
    const svcEnv = svc.env || {}
    const publicEnvKeys = svc.type === 'nextjs'
      ? Object.keys(svcEnv).filter(k => k.startsWith('NEXT_PUBLIC_'))
      : []
    const buildArgBlock = publicEnvKeys.length > 0
      ? `\n          build-args: |\n${publicEnvKeys.map(k =>
            `            ${k}=\${{ vars.${k} || secrets.${k} }}`
          ).join('\n')}`
      : ''

    return `  build-${svc.name}:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
${loginBlock}
      - name: Build & Push ${svc.name}
        uses: docker/build-push-action@v5
        with:
          context: .
          file: ./Dockerfile.${svc.name}
          push: true
          tags: |
            ${imgPath}:latest
            ${imgPath}:\${{ github.sha }}
          cache-from: type=gha,scope=${svc.name}
          cache-to: type=gha,mode=max,scope=${svc.name}${buildArgBlock}`
  }).join('\n\n')

  const needBuilds = appServices.map(s => `build-${s.name}`).join(', ')

  return `name: Grad-Deploy CI/CD

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
${buildJobs}

  update-manifests:
    needs: [${needBuilds}]
    runs-on: ubuntu-latest
    permissions:
      contents: write
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
        with:
          token: \${{ secrets.GITHUB_TOKEN }}
          fetch-depth: 0

      - name: Check for plain text Secrets
        run: |
          if grep -r "^kind: Secret" k8s/ --include="*.yaml" 2>/dev/null | grep -v "SealedSecret"; then
            echo "::error::평문 Secret이 발견되었습니다. SealedSecret을 사용하세요."
            exit 1
          fi
          echo "✅ 평문 Secret 없음"

      - name: Update image tags in kustomization
        run: |
          cd ${overlayDir}
          sed -i "s|newTag: .*|newTag: \${{ github.sha }}|g" kustomization.yaml || true
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add kustomization.yaml
          git diff --staged --quiet || git commit -m "ci: update image tags [\${{ github.sha }}]"
          git pull --rebase origin main
          git push

      # [제거됨] Register Repo to ArgoCD 스텝
      # ─────────────────────────────────────────────────────
      # 이 스텝은 bootstrap.sh 와 중복 등록을 시도하여
      # "existing repository spec is different" 충돌과
      # CONNECTION STATUS=Failed 원인이 되었습니다.
      #
      # Repository 등록은 bootstrap.sh 가 Secret 방식으로
      # 최초 1회만 처리하므로 워크플로우에서는 sync 만 트리거합니다.
      # (옵션 A: 단일 등록 책임 — bootstrap.sh)

      - name: Trigger Argo CD Sync
        env:
          ARGOCD_SERVER: \${{ vars.ARGOCD_SERVER }}
          ARGOCD_AUTH_TOKEN: \${{ secrets.ARGOCD_TOKEN }}
        run: |
          HTTP_STATUS=\$(curl -s -o /tmp/sync_resp.json -w "%{http_code}" \\
            -X POST "https://\${ARGOCD_SERVER}/api/v1/applications/${proj}/sync" \\
            -H "Authorization: Bearer \${ARGOCD_AUTH_TOKEN}" \\
            -H "Content-Type: application/json" \\
            --insecure \\
            -d '{"prune":true,"strategy":{"hook":{"force":false}},"syncOptions":["CreateNamespace=true"]}')
          echo "Argo CD Sync HTTP Status: \${HTTP_STATUS}"
          if [ "\${HTTP_STATUS}" = "401" ]; then
            echo "::error::ARGOCD_TOKEN 만료. Settings → Accounts → admin → Generate New Token"
            exit 1
          elif [ "\${HTTP_STATUS}" = "404" ]; then
            echo "::error::앱 '${proj}'이 없음. kubectl apply -f k8s/argo-app.yaml -n argocd 필요"
            exit 1
          fi`
}

// ── ArgoCD Application ────────────────────────────────
// [변경①] projectName 파라미터 추가
//   기존: project: default 하드코딩 → 모든 팀이 권한 구분 없이 동일 프로젝트 공유
//   변경: project: ${projectName} 동적 할당 → AppProject와 1:1 연결
//
// [변경②] genArgoCDApp()에서 `${proj}-project` 전달
export function genArgoApplication(
  appName,
  repoUrl,
  targetRevision,
  path,
  ns,
  projectName = 'default',  // ← 추가: 기본값 'default' 유지로 하위 호환 보장
) {
  return `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${appName}
  namespace: argocd
  labels:
    app.kubernetes.io/managed-by: grad-deploy
    grad-deploy/project: "${appName}"
spec:
  project: ${projectName}
  source:
    repoURL: ${repoUrl}
    targetRevision: ${targetRevision}
    path: ${path}
  destination:
    server: https://kubernetes.default.svc
    namespace: ${ns}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - PrunePropagationPolicy=foreground
      - ServerSideApply=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers: [/spec/replicas]`
}

// [변경②] ${proj}-project 전달 — genAppProject()와 이름 일치 필수
// path: 'k8s/overlays/production' → 'k8s/projects/${proj}/overlays/production'
// ArgoCD가 감시하는 경로가 buildAllFiles의 overlayDir과 일치해야 함
export function genArgoCDApp(cfg = {}) {
  const { proj = 'my-app', repo = 'https://github.com/ORG/REPO', ns = 'default' } = cfg
  const overlayPath = `k8s/projects/${proj}/overlays/production`
  return genArgoApplication(proj, repo, 'HEAD', overlayPath, ns, `${proj}-project`)
}

// ── ArgoCD Autopilot Bootstrap ────────────────────────
export function genAutopilotBootstrap(proj, repoUrl, ns) {
  // 1. AppProject 생성 (프로젝트 격리)
  const project = genAppProject(proj, ns, repoUrl);
  
  // 2. 부트스트랩용 Application (자기 자신을 관리)
  // path를 k8s/projects/${proj} 전체를 바라보게 하여 argo-appset.yaml도 자동 인식하게 함
  const rootApp = `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${proj}-root-bootstrap
  namespace: argocd
spec:
  project: ${proj}-project
  source:
    repoURL: ${repoUrl}
    targetRevision: HEAD
    path: k8s/projects/${proj}
  destination:
    server: https://kubernetes.default.svc
    namespace: ${ns}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true`;
      
  return [project, rootApp].join('\n---\n');
}

// ── ArgoCD AppProject ─────────────────────────────────
// [추가③] genAppProject() 신규 함수
//
// 기존 코드에 AppProject 생성 로직이 전혀 없었음.
// 모든 Application이 'default' 프로젝트를 공유하면:
//   - 팀A가 팀B의 Application을 sync/delete 가능 (RBAC 없음)
//   - namespace 접근 범위 제한 불가
//   - 역할 2(인증/RBAC)에서 Role 정책을 붙일 대상이 없음
//
// AppProject가 제공하는 것:
//   destinations     → 이 프로젝트 App이 배포할 수 있는 ns/cluster 제한
//   sourceRepos      → 허용된 Git 저장소만 source로 사용 가능
//   clusterResourceWhitelist → Namespace 생성 등 클러스터 수준 리소스 허용 범위
//   namespaceResourceBlacklist → 사용자가 임의로 건드리면 안 되는 리소스 차단
//   roles            → deploy-role: CI(ArgoCD Token)가 sync/get만 가능
//                      역할 2에서 GitHub SSO 그룹을 이 role에 바인딩
export function genAppProject(proj, ns, repoUrl) {
  const projectName = `${proj}-project`
  const namespaces = Array.isArray(ns) ? ns : [ns]
  const destinations = namespaces.map(n => `    - server: https://kubernetes.default.svc\n      namespace: "${n}"`).join('\n')

  return `apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: ${projectName}
  namespace: argocd
  labels:
    app.kubernetes.io/managed-by: grad-deploy
    grad-deploy/project: "${proj}"
  # Finalizer: 프로젝트 삭제 전 소속 Application이 모두 삭제되어야 함
  # GE 엔진 Case 6 (Finalizer Stuck) 방지 — Application을 먼저 지운 뒤 프로젝트 삭제
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  description: "Grad-Deploy managed project for ${proj}"

  # ── 허용 소스 저장소 ──────────────────────────────
  # 이 목록 외 repoURL은 Application에서 사용 불가
  sourceRepos:
    - "${repoUrl}"

  # ── 배포 허용 대상 ────────────────────────────────
  # server + namespace 조합으로 배포 범위를 제한
  # 다른 팀의 namespace에 배포하는 사고를 구조적으로 차단
  destinations:
${destinations}

  # ── 클러스터 수준 리소스 허용 목록 ───────────────
  # Namespace 생성(CreateNamespace=true syncOption)에 필요
  # 나머지 클러스터 리소스(Node, ClusterRole 등)는 기본 차단
  clusterResourceWhitelist: []

  # ── Namespace 수준 리소스 차단 목록 ──────────────
  # ResourceQuota·LimitRange는 플랫폼 팀이 관리
  # 사용자 Application이 임의로 삭제/수정하면 안 됨
  namespaceResourceBlacklist:
    - group: ""
      kind: ResourceQuota
    - group: ""
      kind: LimitRange

  # ── RBAC 역할 정의 ────────────────────────────────
  # deploy-role: GitHub Actions CI가 사용하는 최소 권한 역할
  #   - sync / get 만 허용, delete / update 불가
  #
  # 역할 2(인증/RBAC)에서 GitHub SSO 그룹을 이 role에 바인딩:
  #   argocd-cm ConfigMap의 policy.csv에 추가:
  #   g, github-org:${proj}-team, role:proj:${projectName}:deploy-role
  roles:
    - name: deploy-role
      description: "CI pipeline role — sync and read only"
      policies:
        - p, proj:${projectName}:deploy-role, applications, get,    ${projectName}/*, allow
        - p, proj:${projectName}:deploy-role, applications, sync,   ${projectName}/*, allow
        - p, proj:${projectName}:deploy-role, applications, action, ${projectName}/*, allow
        - p, proj:${projectName}:deploy-role, logs,         get,    ${projectName}/*, allow
    - name: readonly-role
      description: "Read-only access to this project"
      policies:
        - p, proj:${projectName}:readonly-role, applications, get, ${projectName}/*, allow
        - p, proj:${projectName}:readonly-role, logs,         get, ${projectName}/*, allow`
}

// ── ArgoCD ApplicationSet ─────────────────────────────
// Git Generator를 사용해 services/* 폴더 구조를 감시하고
// 폴더가 추가될 때마다 Argo CD가 자동으로 Application을 생성한다.
//
// 기존 방식의 한계:
//   - genArgoCDApp()이 생성하는 단일 Application은 서비스 추가 시마다
//     수동으로 argo-app.yaml을 수정하고 kubectl apply 해야 함.
//
// ApplicationSet이 해결하는 것:
//   - Git 저장소의 k8s/projects/${proj}/services/* 경로를 폴더 단위로 스캔
//   - 새 폴더(= 새 서비스)가 커밋되면 Argo CD가 자동으로 Application을 생성·동기화
//   - 폴더가 삭제되면 Application도 자동 삭제 (prune)
//   - 템플릿 변수 {{path.basename}} 으로 서비스명을 동적 결정
//
// 디렉터리 규칙 (buildAllFiles와 연동):
//   k8s/projects/${proj}/services/${svcName}/  ← 서비스별 매니페스트 루트
//   k8s/projects/${proj}/services/             ← Git Generator가 감시하는 경로
export function genApplicationSet(cfg = {}) {
  const {
    proj     = 'my-app',
    repo     = 'https://github.com/ORG/REPO',
    ns       = 'default',
    revision = 'HEAD',
  } = cfg

  const projectName = `${proj}-project`
  const appSetName  = `${proj}-appset`
  // Git Generator가 감시하는 경로 패턴: services/* 아래의 모든 직계 폴더
  const watchPath   = `k8s/projects/${proj}/services/*`

  return `apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: ${appSetName}
  namespace: argocd
  labels:
    app.kubernetes.io/managed-by: grad-deploy
    grad-deploy/project: "${proj}"
spec:
  # ── Git Generator ──────────────────────────────────
  # k8s/projects/${proj}/services/* 아래의 디렉터리를 자동 탐색.
  # 새 폴더가 커밋되면 아래 template 기반으로 Application을 자동 생성한다.
  generators:
    - git:
        repoURL: ${repo}
        revision: ${revision}
        directories:
          - path: "${watchPath}"

  # ── 동기화 정책 ────────────────────────────────────
  syncPolicy:
    # ApplicationSet이 삭제될 때 생성된 Application도 함께 삭제
    applicationsSync: sync
    # 폴더 삭제 시 해당 Application 자동 삭제 허용
    preserveResourcesOnDeletion: false

  # ── Application 템플릿 ─────────────────────────────
  # {{path.basename}} = 서비스 폴더명 (예: user-service, order-service)
  # {{path}}          = 폴더 전체 경로 (예: k8s/projects/${proj}/services/user-service)
  template:
    metadata:
      # 앱 이름: "<프로젝트>-<서비스폴더명>" 형태로 고유하게 생성
      name: "${proj}-{{path.basename}}"
      namespace: argocd
      labels:
        app.kubernetes.io/managed-by: grad-deploy
        grad-deploy/project: "${proj}"
        grad-deploy/service: "{{path.basename}}"
      annotations:
        # 생성 출처 추적용 — Argo CD UI에서 확인 가능
        grad-deploy/generated-from: "applicationset/${appSetName}"
    spec:
      project: ${projectName}
      source:
        repoURL: ${repo}
        targetRevision: ${revision}
        # 각 서비스 폴더를 kustomize base로 사용
        path: "{{path}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: ${ns}
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - PrunePropagationPolicy=foreground
          - ServerSideApply=true
        retry:
          limit: 5
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
      ignoreDifferences:
        - group: apps
          kind: Deployment
          jsonPointers: [/spec/replicas]`
}


// ════════════════════════════════════════════════════════
//  부모 Application (App-of-Apps 패턴)
// ════════════════════════════════════════════════════════
// ArgoCD UI 에서 ${proj} 이름 하나로 사용자의 모든 서비스를 묶음.
//
// 동작 흐름:
//   1) buildAllFiles 가 결과를 k8s/projects/${proj}/argo-parent-app.yaml 로 push
//   2) server/index.js /api/bootstrap 이 kubectl apply 로 적용
//   3) 부모 Application 이 path 안의 argo-appset.yaml 만 sync (directory.include)
//   4) ApplicationSet 이 services/* 폴더를 자동 스캔 → 자식 Application 생성
//
// 결과 (ArgoCD UI 목록):
//   ${proj}                  ← 부모 (사용자별 1개로 표시)
//   ├── ${proj}-nginx-svc    ← ApplicationSet 이 자동 생성
//   ├── ${proj}-spring-svc
//   └── ${proj}-mysql-svc
//
// 부모를 클릭하면 리소스 그래프에서 ApplicationSet 과 자식 Application 들이
// 트리 구조로 보임 (App-of-Apps 패턴).
//
// genArgoCDApp() 가 만든 단일 Application 과의 차이:
//   - 단일 Application: 서비스 추가 시 매니페스트 수정 필요
//   - 부모 Application: ApplicationSet 가 폴더 감시 → 자동 추가
export function genParentApp(cfg = {}) {
  const {
    proj    = 'my-app',
    repoUrl = 'https://github.com/ORG/REPO',
  } = cfg

  const projectName = `${proj}-project`

  return `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${proj}
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
  labels:
    app.kubernetes.io/managed-by: grad-deploy
    grad-deploy/owner: "${proj}"
    grad-deploy/role: parent
spec:
  project: ${projectName}
  source:
    repoURL: ${repoUrl}
    targetRevision: HEAD
    path: k8s/projects/${proj}
    directory:
      recurse: false
      include: 'argo-appset.yaml'
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true`
}

// ── Argo CD Admin ConfigMap 패치 ──────────────────────
// 플랫폼 담당자(Admin)가 Argo CD 자체를 구성하는 YAML 생성.
//
// 생성 대상:
//   1) argocd-cm     — GitHub SSO OIDC (dex), 리소스 커스터마이징, 상태 배지 활성화
//   2) argocd-rbac-cm — policy.csv RBAC 규칙 (3계층 역할 + 프로젝트별 팀 바인딩)
//   3) setup.sh       — argocd-secret Client Secret 주입 + kubectl apply 순서 안내
//
// [역할2] GitHub SSO 완성 핵심:
//   - dex.config 의 teams[] 를 전달받은 ssoTeams 로 동적 생성
//     → DeployPanel SsoSetupSection 에서 사용자가 입력한 팀 목록이 여기 반영됨
//   - RBAC 3계층 역할 정의:
//       role:admin      — argocd-admin 그룹 매핑 (전체 관리)
//       role:deploy     — CI 파이프라인 전용 (sync/get/update)
//       role:readonly   — 기본 역할, 조회만 허용
//   - argocd-cm / argocd-rbac-cm 을 별도 문자열로 분리하여 반환
//     → buildAllFiles 에서 각각 다른 파일 경로에 저장 가능
//
// ⚠️ 주의사항:
//   - argocd-cm / argocd-rbac-cm 은 ArgoCD 핵심 리소스.
//     Application sync 대상에 포함하면 의도치 않은 덮어쓰기 발생.
//   - AppProject.clusterResourceWhitelist 에 ConfigMap 미포함 (의도적 설계).
//   - 반드시 수동 kubectl apply 또는 Admin 전용 Application(project: default) 으로 배포.
//
// 반환값: { cm, rbac, setup } — 각각 독립 파일로 저장
export function genArgoCDAdminConfig(cfg = {}) {
  const {
    proj           = 'my-app',
    ns             = 'default',
    // GitHub OAuth App Client ID
    // DeployPanel SsoSetupSection 에서 입력받아 GitHub Secret(ARGOCD_GITHUB_CLIENT_ID)에 저장됨
    // argocd-cm 에는 Secret 참조 형식으로 기록 (평문 노출 방지)
    githubClientId = 'REPLACE_WITH_OAUTH_CLIENT_ID',
    // ssoTeams: DeployPanel 에서 사용자가 추가한 팀 목록
    // 형식: [{ team: 'leesean2', role: 'deploy' | 'admin' | 'readonly' }]
    // dex teams[] 와 policy.csv g 규칙 모두 이 값으로 동적 생성됨
    ssoTeams       = [],
    argocdServer   = 'argocd.example.com',
  } = cfg

  const projectName = `${proj}-project`

  // ── dex 사용자 동적 생성 ─────────────────────────
  // DeployPanel에서 입력한 사용자들의 로그인을 허용.
  const uniqueUsers = [...new Set(ssoTeams.map(t => t.team).filter(Boolean))]
  // orgs 블록을 삭제하므로, 별도로 dexTeamsBlock을 사용하지 않습니다.

  // ── argocd-cm ─────────────────────────────────────
  const argoCDCM = `apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: argocd
    app.kubernetes.io/managed-by: grad-deploy
  annotations:
    grad-deploy/note: >
      플랫폼 담당자 전용. Application sync 대상에서 제외할 것.
      변경: kubectl apply -f k8s/argocd-admin/argocd-cm.yaml -n argocd
      SSO 설정 후 반드시 setup.sh 를 실행해 Client Secret 을 주입하세요.
data:
  # ── GitHub SSO (Dex OIDC) ────────────────────────────
  # 사전 준비 (GitHub OAuth App 생성):
  #   GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
  #   Homepage URL   : https://${argocdServer}
  #   Callback URL   : https://${argocdServer}/api/dex/callback
  #
  # Client ID  → DeployPanel "SSO 설정" 탭에 입력 → GitHub Secret ARGOCD_GITHUB_CLIENT_ID 에 저장
  # Client Secret → setup.sh 를 실행해 argocd-secret 에 직접 주입 (Git 에 저장 금지)
  dex.config: |
    connectors:
      - type: github
        id: github
        name: GitHub
        config:
          clientID: ${githubClientId}
          clientSecret: $dex.github.clientSecret
          redirectURI: https://${argocdServer}/api/dex/callback

  # ── 리소스 커스터마이징 ─────────────────────────────
  # HPA 가 replicas 를 자동 조정할 때 spec.replicas diff 로 OutOfSync 오탐 방지
  resource.customizations.ignoreDifferences.apps_Deployment: |
    jsonPointers:
      - /spec/replicas

  # ── 상태 배지 + 리소스 추적 방식 ──────────────────────
  statusbadge.enabled: "true"
  application.resourceTrackingMethod: label

  # ── UI 배너 ───────────────────────────────────────────
  ui.bannercontent: "Grad-Deploy Managed Cluster — ${proj}"
  ui.bannerurl: "https://${argocdServer}"`

  // ── RBAC 3계층 역할 정의 ──────────────────────────
  // role:admin    — Argo CD 전체 관리 (argocd-admins GitHub 팀 매핑)
  //                 argocd-cm 변경, AppProject 생성 등 모든 권한
  // role:deploy   — CI 파이프라인 전용 (genAppProject deploy-role 과 동일 권한)
  //                 sync / get / update 만 허용, 설정 변경 불가
  // role:readonly — 기본값, 조회만 허용
  //                 인증은 됐지만 명시적 역할 미지정 사용자에게 자동 부여
  const roleDefinitions = [
    `# ════════════════════════════════════════════════════`,
    `# Grad-Deploy RBAC 정책 (Casbin policy.csv 형식)`,
    `# p 규칙: p, <role>, <resource>, <action>, <scope>, <effect>`,
    `# g 규칙: g, <subject(GitHub 유저명)>, <role>`,
    `# GitHub 유저명 형식: "leesean2"  예) g, leesean2, role:admin`,
    `# ════════════════════════════════════════════════════`,
    ``,
    `# ── role:admin — 전체 관리자 ─────────────────────────`,
    `# 지정된 관리자(GitHub 유저)에게 부여`,
    `# Argo CD 내 모든 리소스 생성/수정/삭제 가능`,
    `p, role:admin, applications,    *, */*, allow`,
    `p, role:admin, applicationsets, *, */*, allow`,
    `p, role:admin, clusters,        *, */*, allow`,
    `p, role:admin, repositories,    *, */*, allow`,
    `p, role:admin, accounts,        *, */*, allow`,
    `p, role:admin, certificates,    *, */*, allow`,
    `p, role:admin, gpgkeys,         *, */*, allow`,
    `p, role:admin, logs,            *, */*, allow`,
    `p, role:admin, exec,            *, */*, allow`,
  ]

  // ── 사용자 → 역할 그룹 바인딩 ─────────────────────────
  // ssoTeams 에서 입력받은 사용자(team 필드) 단위로 g 규칙 생성
  // role 값: 'admin' | 'deploy' | 'readonly'
  const groupBindings = [
    ``,
    `# ── 유저명 기준 역할 바인딩 (DeployPanel 연동) ─────`,
  ]

  if (ssoTeams.length > 0) {
    ssoTeams.forEach(t => {
      if (!t.team) return
      const targetProjName = t.proj ? `${t.proj}-project` : projectName;
      const roleName = t.role === 'admin'    ? 'role:admin'
                     : t.role === 'deploy'   ? `role:proj:${targetProjName}:deploy-role`
                     : /* readonly 기본값 */   `role:proj:${targetProjName}:readonly-role`
      groupBindings.push(
        `g, ${t.team}, ${roleName}`
      )
    })
  } else {
    groupBindings.push(
      `# 사용자가 지정되지 않았습니다.`,
      `# DeployPanel SSO 설정 탭에서 사용자를 추가하면 여기에 자동 반영됩니다.`,
      `# 예시: g, leesean2, role:admin`,
    )
  }

  const allPolicyCsv = [...roleDefinitions, ...groupBindings].join('\n    ')

  // ── argocd-rbac-cm ────────────────────────────────
  const argoRBACCM = `apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: argocd
    app.kubernetes.io/managed-by: grad-deploy
  annotations:
    grad-deploy/note: >
      플랫폼 담당자 전용. Application sync 대상에서 제외할 것.
      변경: kubectl apply -f k8s/argocd-admin/argocd-rbac-cm.yaml -n argocd
data:
  # 명시적 역할 미지정 사용자는 기본적으로 조회 권한
  policy.default: role:readonly

  policy.csv: |
    ${allPolicyCsv}

  # GitHub 유저명으로 매핑하므로 이메일 스코프 등 사용
  scopes: "[email]"`

  // ── setup.sh ──────────────────────────────────────
  // Client Secret 은 Git 에 저장할 수 없으므로 kubectl patch 로 직접 주입.
  // 이 스크립트를 실행하면 argocd-secret 에 dex.github.clientSecret 가 추가됨.
  const setupSh = `#!/bin/bash
# ════════════════════════════════════════════════════════
#  Grad-Deploy — Argo CD GitHub SSO 초기화 스크립트
#  실행: bash k8s/argocd-admin/setup.sh
#
#  사전 준비:
#    1) GitHub OAuth App 생성 (README 참고)
#    2) CLIENT_ID, CLIENT_SECRET 환경변수 설정 후 실행
#       export ARGOCD_CLIENT_ID="Ov23li..."
#       export ARGOCD_CLIENT_SECRET="abc123..."
# ════════════════════════════════════════════════════════
set -euo pipefail

ARGOCD_NS="argocd"

echo "▶ 1단계: argocd-cm 적용 (GitHub SSO dex 설정)"
kubectl apply -f "$(dirname "$0")/argocd-cm.yaml" -n "\${ARGOCD_NS}"

echo "▶ 2단계: argocd-rbac-cm 적용 (RBAC 정책)"
kubectl apply -f "$(dirname "$0")/argocd-rbac-cm.yaml" -n "\${ARGOCD_NS}"

echo "▶ 3단계: GitHub OAuth Client Secret 주입"
# Client Secret 은 절대 Git 에 커밋하지 마세요.
# argocd-secret 에 직접 patch 합니다.
if [ -z "\${ARGOCD_CLIENT_SECRET:-}" ]; then
  echo "  ⚠ ARGOCD_CLIENT_SECRET 환경변수가 없습니다."
  read -rsp "  GitHub OAuth Client Secret 입력: " ARGOCD_CLIENT_SECRET
  echo ""
fi

kubectl patch secret argocd-secret -n "\${ARGOCD_NS}" \\
  --type='json' \\
  -p="[{\\\"op\\\":\\\"add\\\",\\\"path\\\":\\\"/data/dex.github.clientSecret\\\",\\\"value\\\":\\\"$(echo -n \${ARGOCD_CLIENT_SECRET} | base64 | tr -d '\\n')\\\"}]"
echo "  ✓ Client Secret 주입 완료"

echo "▶ 4단계: dex 및 server 재시작 (설정 반영)"
kubectl rollout restart deployment argocd-dex-server -n "\${ARGOCD_NS}"
kubectl rollout restart deployment argocd-server -n "\${ARGOCD_NS}"
kubectl rollout status deployment argocd-dex-server -n "\${ARGOCD_NS}" --timeout=60s
kubectl rollout status deployment argocd-server -n "\${ARGOCD_NS}" --timeout=60s

echo "▶ 5단계: deploy-role 전용 토큰 발급 안내"
cat << 'EOF'
  ────────────────────────────────────────────────────
  GitHub Secret ARGOCD_TOKEN 에는 admin 토큰 대신
  deploy-role 전용 토큰을 등록해야 합니다. (최소 권한 원칙)

  발급 방법 (Argo CD CLI):
    argocd login ${argocdServer}
    argocd proj role create-token ${proj}-project deploy-role

  발급한 토큰을 GitHub Repository Secret 에 등록:
    gh secret set ARGOCD_TOKEN --body "<발급된 토큰>"
  ────────────────────────────────────────────────────
EOF

echo ""
echo "✅ Argo CD GitHub SSO 설정 완료"
echo "   브라우저에서 https://${argocdServer} 접속 후"
echo "   'Login with GitHub' 버튼으로 SSO 인증을 확인하세요."`

   // cm, rbac, setup 을 각각 분리 반환
  // buildAllFiles 에서 별도 파일에 저장:
  //   argocd-admin/argocd-cm.yaml
  //   argocd-admin/argocd-rbac-cm.yaml
  //   argocd-admin/setup.sh
  //   argocd-admin/test-rbac.sh
  
  const testRbacSh = `#!/bin/bash
# ════════════════════════════════════════════════════════
#  Grad-Deploy — RBAC 권한 검증 스크립트
#  실행: bash k8s/argocd-admin/test-rbac.sh <프로젝트명> <토큰>
# ════════════════════════════════════════════════════════
set -e

PROJ=$1
TOKEN=$2
ARGOCD_SERVER="${argocdServer}"

if [ -z "$PROJ" ] || [ -z "$TOKEN" ]; then
  echo "사용법: bash test-rbac.sh <프로젝트명> <토큰>"
  echo "예시: bash test-rbac.sh my-app eyJhbGci..."
  exit 1
fi

echo "▶ $PROJ 프로젝트 권한 검증 중..."
echo "서버: https://$ARGOCD_SERVER"
echo ""

echo "1. 프로젝트 정보 조회 테스트"
if curl -s -k -H "Authorization: Bearer $TOKEN" "https://$ARGOCD_SERVER/api/v1/projects/$PROJ-project" | grep -q "$PROJ"; then
  echo "  ✓ 프로젝트 조회 성공"
else
  echo "  ✕ 프로젝트 조회 실패 (권한 없음)"
fi

echo "2. 애플리케이션 목록 조회 테스트"
if curl -s -k -H "Authorization: Bearer $TOKEN" "https://$ARGOCD_SERVER/api/v1/applications?project=$PROJ-project" | grep -q "items"; then
  echo "  ✓ 애플리케이션 목록 조회 성공"
else
  echo "  ✕ 애플리케이션 목록 조회 실패 (권한 없음)"
fi
`

  return { cm: argoCDCM, rbac: argoRBACCM, setup: setupSh, testRbac: testRbacSh }
}

// ── ResourceQuota + LimitRange ────────────────────────
// [추가④] genResourceQuota() 신규 함수
//
// 기존 문제:
//   guardrail.js RA-04 규칙이 "ResourceQuota 미설정" WARNING을 발생시키지만
//   실제로 ResourceQuota YAML을 생성하는 함수가 없었음.
//   → 경고만 있고 자동 수정 수단이 없는 반쪽짜리 가드레일.
//
// 이 함수가 하는 일:
//   1) 서비스 목록의 cpuReq / memReq 를 합산해서 namespace 전체 상한(hard) 설정
//      → Noisy Neighbor(RA-04) 방지
//   2) LimitRange로 Request 미설정(RA-01) 서비스에 기본값 강제 주입
//      → BestEffort QoS Pod 생성 차단
//
// AppProject의 namespaceResourceBlacklist에 등록되어
// 사용자 Application이 이 파일을 덮어쓰거나 삭제할 수 없음.
export function genResourceQuota(services, ns, opts = {}) {
  const { marginFactor = 1.5 } = opts

  // ── CPU/Memory 합산 ────────────────────────────────
  const parseMilliCPU = v => {
    if (!v) return 0
    if (String(v).endsWith('m')) return parseInt(v)
    return parseFloat(v) * 1000
  }
  const parseMiB = v => {
    if (!v) return 0
    if (String(v).endsWith('Gi')) return parseFloat(v) * 1024
    if (String(v).endsWith('Mi')) return parseFloat(v)
    return parseFloat(v)
  }

  let totalCpuMilli = 0
  let totalMemMiB = 0
  let totalPods = 0

  services.forEach(svc => {
    const t = SERVICE_TEMPLATES[svc.type] || {}
    const rep = parseInt(svc.replicas) || 1
    const cpuReq = svc.cpuReq || t.cpuReq || '100m'
    const memReq = svc.memReq || t.memReq || '256Mi'
    totalCpuMilli += parseMilliCPU(cpuReq) * rep
    totalMemMiB   += parseMiB(memReq) * rep
    // HPA가 있으면 maxReplicas까지 스케일될 수 있으므로 pod 수 여유 있게 계산
    totalPods += svc.hpa ? (parseInt(svc.maxRep) || 10) : rep
  })

  // marginFactor 1.5 → 서비스 합산의 1.5배로 namespace 상한 설정
  const quotaCpuMilli = Math.ceil(totalCpuMilli * marginFactor)
  const quotaMemMiB   = Math.ceil(totalMemMiB   * marginFactor)
  const quotaCpuLimMilli = quotaCpuMilli * 2
  const quotaMemLimMiB   = quotaMemMiB   * 2

  const fmtCPU = v => v >= 1000 ? `${(v / 1000).toFixed(1)}` : `${v}m`
  const fmtMem = v => v >= 1024 ? `${(v / 1024).toFixed(1)}Gi` : `${v}Mi`

  const dbCount = services.filter(s => (SERVICE_TEMPLATES[s.type] || {}).isDB).length

  return `apiVersion: v1
kind: ResourceQuota
metadata:
  name: ${ns}-quota
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: grad-deploy
  annotations:
    grad-deploy/total-services: "${services.length}"
    grad-deploy/margin-factor: "${marginFactor}"
    grad-deploy/note: >
      Grad-Deploy 자동 계산값. AppProject namespaceResourceBlacklist에 의해
      사용자 Application이 수정/삭제 불가. 변경 시 kubectl apply 직접 사용.
spec:
  hard:
    # 서비스 합산 Request × ${marginFactor} (여유 배수)
    requests.cpu: "${fmtCPU(quotaCpuMilli)}"
    requests.memory: "${fmtMem(quotaMemMiB)}"
    # Limit은 Request의 2배 (RA-03 Throttling 방지)
    limits.cpu: "${fmtCPU(quotaCpuLimMilli)}"
    limits.memory: "${fmtMem(quotaMemLimMiB)}"
    # Pod / 오브젝트 수 상한
    pods: "${Math.ceil(totalPods * marginFactor)}"
    services: "${services.length * 3}"
    persistentvolumeclaims: "${dbCount * 2}"
    secrets: "${services.length * 4}"
    configmaps: "${services.length * 4}"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: ${ns}-limitrange
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: grad-deploy
  annotations:
    grad-deploy/note: >
      RA-01(BestEffort QoS 방지): Request 미설정 Pod에 default 값을 자동 주입.
      max 값으로 단일 Pod의 자원 독점(RA-04)을 차단.
spec:
  limits:
    - type: Container
      # Request 미설정 시 자동 주입되는 기본값 (RA-01 방지)
      defaultRequest:
        cpu: "100m"
        memory: "256Mi"
      # Limit 미설정 시 자동 주입되는 기본값
      default:
        cpu: "500m"
        memory: "512Mi"
      # 단일 컨테이너 최대값 — Noisy Neighbor(RA-04) 차단
      max:
        cpu: "2000m"
        memory: "4Gi"
      # 최소값 — Probe 동작 보장 하한선
      min:
        cpu: "10m"
        memory: "32Mi"`
}

// ── 배포 순서 안내 README ─────────────────────────────
// buildAllFiles()에서 k8s/projects/<proj>/docs/deploy-order.md 로 push됨
// ApplicationSet 기반 흐름으로 업데이트: AppProject → ApplicationSet → (자동 앱 생성)
function genDeployOrderReadme(proj, ns) {
  const projectName = `${proj}-project`
  const appSetName  = `${proj}-appset`
  const projRoot    = `k8s/projects/${proj}`
  return `# Grad-Deploy 배포 순서 안내

## 아키텍처 개요

\`\`\`
Git Push (서비스 폴더 추가)
    └─► GitHub Actions (이미지 빌드 + 태그 갱신)
              └─► Argo CD ApplicationSet (폴더 감시)
                        └─► Application 자동 생성 (서비스당 1개)
                                  └─► K8s 클러스터 자동 배포
\`\`\`

**기존 방식과의 차이:**
- 기존: 서비스 추가 시마다 \`argo-app.yaml\` 수동 편집 + \`kubectl apply\` 필요
- 신규: \`${projRoot}/services/<새서비스폴더>\` 커밋만 하면 Argo CD가 Application을 자동 생성

---

## 첫 배포 — 플랫폼 담당자 전용 (최초 1회)

아래 3단계는 **한 번만** 수동으로 apply합니다. 이후에는 Git Push만으로 자동 배포됩니다.

### 0단계 — Argo CD Admin 설정 (GitHub SSO·RBAC)

\`\`\`bash
# argocd namespace에 적용 (Application sync 대상 아님)
kubectl apply -f k8s/argocd-admin/ -n argocd

# GitHub OAuth App이 준비되어 있어야 합니다.
# argocd-secret에 GitHub OAuth Client Secret 추가:
kubectl -n argocd patch secret argocd-secret \\
  -p '{"stringData":{"dex.github.clientSecret":"<YOUR_CLIENT_SECRET>"}}'
\`\`\`

> ⚠️ \`k8s/argocd-admin/\` 내 파일은 Application sync 대상에서 **반드시 제외**하세요.
> AppProject.clusterResourceWhitelist가 ConfigMap 수정을 허용하지 않습니다.

### 1단계 — AppProject 생성

\`\`\`bash
kubectl apply -f ${projRoot}/argo-project.yaml -n argocd
\`\`\`

- \`${projectName}\` 프로젝트를 먼저 생성합니다.
- 이 단계를 건너뛰면 ApplicationSet sync 시 "project not found" 오류가 발생합니다.

### 2단계 — ApplicationSet 생성

\`\`\`bash
kubectl apply -f ${projRoot}/argo-appset.yaml -n argocd
\`\`\`

- Argo CD가 \`${projRoot}/services/*\` 경로를 폴더 단위로 감시합니다.
- 폴더가 있으면 즉시 Application을 자동 생성합니다.
- 이후 서비스 폴더를 추가·삭제하면 Application이 자동으로 생성·삭제됩니다.

### 3단계 — ResourceQuota + LimitRange 적용

\`\`\`bash
kubectl apply -f ${projRoot}/base/resource-quota.yaml -n ${ns}
\`\`\`

- namespace \`${ns}\`의 자원 상한을 설정합니다.
- AppProject \`namespaceResourceBlacklist\`에 의해 Application이 이 파일을 수정·삭제할 수 없습니다.

---

## 이후 배포 — 개발자 (반복)

### 신규 서비스 추가

\`\`\`bash
# 1. 서비스 폴더 생성 (Grad-Deploy UI에서 자동 생성됨)
mkdir -p ${projRoot}/services/<new-service>
# deployment.yaml, service.yaml 등 배치

# 2. Git Push
git add ${projRoot}/services/<new-service>
git commit -m "feat: add <new-service>"
git push origin main

# → Argo CD ApplicationSet이 폴더를 감지하고 Application 자동 생성
\`\`\`

### 이미지 태그 갱신 (CI가 자동 처리)

main 브랜치 push → GitHub Actions → \`kustomization.yaml\` 이미지 태그 갱신 → Argo CD 자동 sync

수동 sync:
\`\`\`bash
argocd app sync ${proj}-<서비스명> --server <ARGOCD_SERVER>
\`\`\`

---

### 🚨 트러블슈팅 가이드 (장애 발생 시)

문제가 발생했을 때 다음 명령어들로 상태를 확인하세요:

1. **Argo CD 배포 상태 확인**
   \`\`\`bash
   # 특정 서비스 헬스 체크 완료 대기 (명확한 가시성)
   argocd app wait ${proj}-<서비스명> --health
   # 동기화 문제가 있을 경우 강제 동기화 수행
   argocd app sync ${proj}-<서비스명> --force
   # 또는 전체 애플리케이션 상태 확인
   argocd app list | grep ${proj}
   \`\`\`

2. **Kubernetes 파드(Pod) 상태 확인**
   \`\`\`bash
   kubectl get pods -n ${ns}
   kubectl describe pod <파드이름> -n ${ns}
   \`\`\`

3. **로그 확인**
   \`\`\`bash
   kubectl logs -f deployment/<서비스명> -n ${ns}
   \`\`\`

---

## 파일 구조

\`\`\`
k8s/
├── argocd-admin/                      # 플랫폼 전용 — sync 대상 제외
│   ├── argocd-cm.yaml                 # GitHub SSO OIDC 설정
│   └── argocd-rbac-cm.yaml            # RBAC policy.csv
└── projects/
    └── ${proj}/                       # 팀별 독립 경로 (Multi-tenant)
        ├── argo-project.yaml          # AppProject (0단계)
        ├── argo-appset.yaml           # ApplicationSet (1단계) ← 핵심
        ├── argo-app.yaml              # 단일 Application (레거시 참조용)
        ├── base/
        │   └── resource-quota.yaml   # ResourceQuota + LimitRange (2단계)
        ├── services/                  # ApplicationSet Git Generator 감시 경로
        │   └── <svcName>/            # 서비스 폴더 추가 = Application 자동 생성
        │       ├── deployment.yaml
        │       ├── service.yaml
        │       ├── hpa.yaml           # HPA 활성화 시
        │       └── nginx-conf.yaml    # nginx/react-nginx 타입 시
        ├── overlays/
        │   └── production/
        │       ├── kustomization.yaml
        │       ├── networkpolicy.yaml
        │       └── ingress.yaml       # kind/local 환경만
        └── docs/
            ├── deploy-order.md        # 이 파일
            └── ingress-setup.md
.github/
└── workflows/
    └── ci.yaml                        # 이미지 빌드 + Argo CD sync 트리거
Dockerfile.<svcName>                   # 서비스별 Dockerfile
kind-config.yaml                       # kind 클러스터 설정 (kind/local)
\`\`\`
`
}

// ── 매니페스트 미리보기 (Deployment + Service + HPA + nginx.conf) ──
export function buildManifestYAML(services, ns, cloud = 'kind') {
  const chunks = []
  services.forEach(svc => {
    const d = genDeployment(svc, ns, cloud)
    const sv = genService(svc, ns, cloud)
    const hpa = genHPA(svc, ns)
    const nginxConf = genNginxConf(svc, services, ns)

    chunks.push(`# ${'─'.repeat(4)} ${svc.name.toUpperCase()} ${'─'.repeat(Math.max(0, 38 - svc.name.length))}`)
    chunks.push(d, sv)
    if (nginxConf) chunks.push(nginxConf)
    if (hpa) chunks.push(hpa)
  })
  // kind 환경이면 Ingress도 미리보기에 포함
  const ingress = genIngress(services, ns, cloud)
  if (ingress) {
    chunks.push(`# ${'─'.repeat(4)} INGRESS ${'─'.repeat(30)}`)
    chunks.push(ingress)
  }
  return chunks.join('\n---\n')
}

// ════════════════════════════════════════════════════════
//  [Task 1] Argo CD 운영 환경 검증 산출물 생성
//
//  §2.1 클러스터 환경 확인 스크립트
//  §2.2 admin 운영 절차 스크립트
//  §2.3 ApplicationSet 검증 스크립트
//  §2.4 장애 상태별 확인 루틴 문서
//  §3   admin 운영 절차 + 체크리스트 통합 문서
// ════════════════════════════════════════════════════════

// ── §2.1 클러스터 환경 확인 스크립트 ──────────────────
// scripts/check-admin-cluster.sh
// Argo CD namespace, 핵심 Pod, metrics-server, Ingress Controller,
// GHCR imagePullSecret 적용 여부를 한 번에 확인
export function genCheckAdminCluster(proj, ns) {
  return `#!/usr/bin/env bash
# ════════════════════════════════════════════════════════
#  Grad-Deploy — Argo CD 운영 클러스터 환경 확인
#  Task 1 §2.1  |  실행: bash scripts/check-admin-cluster.sh
# ════════════════════════════════════════════════════════
set -euo pipefail

PROJ="${proj}"
NS="${ns}"
ARGOCD_NS="argocd"
PASS=0
FAIL=0
WARN=0

print_header() { echo ""; echo "══════════════════════════════════════"; echo "  $1"; echo "══════════════════════════════════════"; }
check_pass()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
check_fail()   { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
check_warn()   { echo "  ⚠️  $1"; WARN=$((WARN+1)); }

print_header "1. Kubernetes 클러스터 접근 확인"
if kubectl cluster-info &>/dev/null; then
  check_pass "클러스터 접근 가능"
  kubectl cluster-info | head -2 | sed 's/^/  │ /'
else
  check_fail "클러스터에 접근할 수 없습니다. kubeconfig를 확인하세요."
  echo "  결과: PASS=\${PASS} FAIL=\${FAIL} WARN=\${WARN}"
  exit 1
fi

print_header "2. Argo CD namespace 확인"
if kubectl get ns \${ARGOCD_NS} &>/dev/null; then
  check_pass "namespace '\${ARGOCD_NS}' 존재"
else
  check_fail "namespace '\${ARGOCD_NS}'가 없습니다. Argo CD를 설치하세요."
fi

print_header "3. Argo CD 핵심 Pod 상태"
for COMPONENT in argocd-server argocd-repo-server argocd-application-controller; do
  POD_STATUS=\$(kubectl get pods -n \${ARGOCD_NS} -l app.kubernetes.io/name=\${COMPONENT} \\
    -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "NotFound")
  if [ "\${POD_STATUS}" = "Running" ]; then
    check_pass "\${COMPONENT}: Running"
  elif [ "\${POD_STATUS}" = "NotFound" ]; then
    check_fail "\${COMPONENT}: Pod 없음"
  else
    check_warn "\${COMPONENT}: \${POD_STATUS}"
  fi
done

print_header "4. Argo CD CRD 설치 확인"
for CRD in applications.argoproj.io applicationsets.argoproj.io appprojects.argoproj.io; do
  if kubectl get crd \${CRD} &>/dev/null; then
    check_pass "CRD \${CRD} 설치됨"
  else
    check_fail "CRD \${CRD} 누락"
  fi
done

print_header "5. metrics-server 설치 여부"
if kubectl get deployment metrics-server -n kube-system &>/dev/null; then
  check_pass "metrics-server 설치됨 (HPA 사용 가능)"
else
  check_warn "metrics-server 미설치 — HPA 자동 스케일링이 동작하지 않습니다"
  echo "  │ 설치: kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml"
fi

print_header "6. Ingress Controller 설치 여부"
INGRESS_PODS=\$(kubectl get pods -A -l app.kubernetes.io/name=ingress-nginx \\
  --field-selector=status.phase=Running -o name 2>/dev/null | wc -l | tr -d ' ')
if [ "\${INGRESS_PODS}" -gt 0 ]; then
  check_pass "Nginx Ingress Controller 실행 중 (\${INGRESS_PODS} pods)"
else
  check_warn "Nginx Ingress Controller 미설치 — 외부 접근이 제한될 수 있습니다"
  echo "  │ kind 설치: kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml"
fi

print_header "7. GHCR imagePullSecret 확인"
SECRET_NAME="ghcr-pull-secret"
if kubectl get secret \${SECRET_NAME} -n \${NS} &>/dev/null; then
  check_pass "imagePullSecret '\${SECRET_NAME}' 존재 (ns: \${NS})"
else
  HAS_DOCKERCFG=\$(kubectl get secret -n \${NS} -o jsonpath='{range .items[*]}{.type}{"\\n"}{end}' 2>/dev/null | grep -c 'kubernetes.io/dockerconfigjson' || true)
  if [ "\${HAS_DOCKERCFG}" -gt 0 ]; then
    check_pass "dockerconfigjson 타입 Secret 존재 (\${HAS_DOCKERCFG}개)"
  else
    check_warn "GHCR imagePullSecret 없음 — private 이미지 Pull 시 ImagePullBackOff 발생 가능"
    echo "  │ 생성 예시:"
    echo "  │ kubectl create secret docker-registry \${SECRET_NAME} -n \${NS} \\\\"
    echo "  │   --docker-server=ghcr.io \\\\"
    echo "  │   --docker-username=<GITHUB_USER> \\\\"
    echo "  │   --docker-password=<GITHUB_PAT>"
  fi
fi

print_header "8. 프로젝트 namespace 확인"
if kubectl get ns \${NS} &>/dev/null; then
  check_pass "namespace '\${NS}' 존재"
else
  check_warn "namespace '\${NS}'가 아직 없습니다 (Argo CD syncOption CreateNamespace=true로 자동 생성 예정)"
fi

# ── 결과 요약 ────────────────────────────────────────
print_header "결과 요약"
echo "  ✅ PASS: \${PASS}"
echo "  ❌ FAIL: \${FAIL}"
echo "  ⚠️  WARN: \${WARN}"
echo ""
if [ \${FAIL} -gt 0 ]; then
  echo "  🚫 FAIL이 있습니다. 위 항목을 해결한 뒤 다시 실행하세요."
  exit 1
else
  echo "  ✅ 클러스터 환경이 정상입니다."
fi
`
}

// ── §2.2 Argo CD admin 상태 확인 스크립트 ────────────
// scripts/check-argocd-status.sh
// admin 초기 비밀번호, 접속 URL, 전체 리소스 상태를 한 번에 조회
export function genCheckArgoCDStatus(proj, ns) {
  return `#!/usr/bin/env bash
# ════════════════════════════════════════════════════════
#  Grad-Deploy — Argo CD Admin 상태 확인
#  Task 1 §2.2  |  실행: bash scripts/check-argocd-status.sh
# ════════════════════════════════════════════════════════
set -euo pipefail

PROJ="${proj}"
NS="${ns}"
ARGOCD_NS="argocd"

print_header() { echo ""; echo "══════════════════════════════════════"; echo "  $1"; echo "══════════════════════════════════════"; }

print_header "1. Argo CD admin 초기 비밀번호"
echo "  다음 명령으로 초기 비밀번호를 확인하세요:"
echo ""
echo "  kubectl -n \${ARGOCD_NS} get secret argocd-initial-admin-secret \\\\"
echo "    -o jsonpath='{.data.password}' | base64 -d; echo"
echo ""
ADMIN_PW=\$(kubectl -n \${ARGOCD_NS} get secret argocd-initial-admin-secret \\
  -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
if [ -n "\${ADMIN_PW}" ]; then
  echo "  📋 현재 초기 비밀번호: \${ADMIN_PW}"
else
  echo "  ⚠️  초기 비밀번호 Secret이 없습니다 (이미 변경되었거나 삭제됨)"
fi

print_header "2. Argo CD 접속 URL"
echo "  방법 A — port-forward (로컬 접속):"
echo "    kubectl port-forward svc/argocd-server -n \${ARGOCD_NS} 8080:443"
echo "    → https://localhost:8080"
echo ""
echo "  방법 B — Ingress 확인:"
kubectl get ingress -n \${ARGOCD_NS} 2>/dev/null || echo "    (Ingress 없음)"
echo ""
echo "  방법 C — NodePort 확인:"
kubectl get svc argocd-server -n \${ARGOCD_NS} -o jsonpath='{.spec.type}' 2>/dev/null || true
echo ""

print_header "3. Applications 목록"
kubectl get applications -n \${ARGOCD_NS} -o wide 2>/dev/null || echo "  (Application 없음)"

print_header "4. ApplicationSets 목록"
kubectl get applicationsets -n \${ARGOCD_NS} -o wide 2>/dev/null || echo "  (ApplicationSet 없음)"

print_header "5. AppProjects 목록"
kubectl get appprojects -n \${ARGOCD_NS} -o wide 2>/dev/null || echo "  (AppProject 없음)"

print_header "6. Repositories 연결 상태"
kubectl get secrets -n \${ARGOCD_NS} -l argocd.argoproj.io/secret-type=repository \\
  -o custom-columns='NAME:.metadata.name,URL:.data.url' 2>/dev/null || echo "  (Repository Secret 없음)"

print_header "7. Argo CD Pod 리소스 사용량"
kubectl top pods -n \${ARGOCD_NS} 2>/dev/null || echo "  (metrics-server 미설치)"

print_header "8. Application Sync/Health 요약"
echo ""
echo "  │ 상태별 집계:"
for STATUS in Synced OutOfSync Unknown; do
  COUNT=\$(kubectl get applications -n \${ARGOCD_NS} -o jsonpath="{.items[?(@.status.sync.status=='\${STATUS}')].metadata.name}" 2>/dev/null | wc -w | tr -d ' ')
  echo "  │   \${STATUS}: \${COUNT}"
done
echo ""
for HEALTH in Healthy Degraded Progressing Missing Unknown; do
  COUNT=\$(kubectl get applications -n \${ARGOCD_NS} -o jsonpath="{.items[?(@.status.health.status=='\${HEALTH}')].metadata.name}" 2>/dev/null | wc -w | tr -d ' ')
  echo "  │   \${HEALTH}: \${COUNT}"
done

echo ""
echo "✅ Argo CD 상태 확인 완료"
`
}

// ── §2.3 ApplicationSet 검증 스크립트 ────────────────
// scripts/check-applicationset.sh
// AppProject 존재, ApplicationSet 감시 경로, 자동 생성 확인
export function genCheckApplicationSet(proj, ns) {
  const projectName = `${proj}-project`
  const appSetName  = `${proj}-appset`
  const svcPath     = `k8s/projects/${proj}/services`

  return `#!/usr/bin/env bash
# ════════════════════════════════════════════════════════
#  Grad-Deploy — ApplicationSet 검증
#  Task 1 §2.3  |  실행: bash scripts/check-applicationset.sh
# ════════════════════════════════════════════════════════
set -euo pipefail

PROJ="${proj}"
NS="${ns}"
ARGOCD_NS="argocd"
PROJECT_NAME="${projectName}"
APPSET_NAME="${appSetName}"
SVC_PATH="${svcPath}"
PASS=0
FAIL=0

print_header() { echo ""; echo "══════════════════════════════════════"; echo "  $1"; echo "══════════════════════════════════════"; }
check_pass()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
check_fail()   { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

print_header "1. AppProject 존재 확인"
if kubectl get appproject \${PROJECT_NAME} -n \${ARGOCD_NS} &>/dev/null; then
  check_pass "AppProject '\${PROJECT_NAME}' 존재"
  echo "  │ sourceRepos:"
  kubectl get appproject \${PROJECT_NAME} -n \${ARGOCD_NS} \\
    -o jsonpath='{range .spec.sourceRepos[*]}  │   {@}{"\\n"}{end}' 2>/dev/null
  echo "  │ destinations:"
  kubectl get appproject \${PROJECT_NAME} -n \${ARGOCD_NS} \\
    -o jsonpath='{range .spec.destinations[*]}  │   ns={.namespace} server={.server}{"\\n"}{end}' 2>/dev/null
else
  check_fail "AppProject '\${PROJECT_NAME}'가 없습니다"
  echo "  │ 생성: kubectl apply -f k8s/projects/\${PROJ}/argo-project.yaml -n \${ARGOCD_NS}"
fi

print_header "2. ApplicationSet 존재 확인"
if kubectl get applicationset \${APPSET_NAME} -n \${ARGOCD_NS} &>/dev/null; then
  check_pass "ApplicationSet '\${APPSET_NAME}' 존재"
else
  check_fail "ApplicationSet '\${APPSET_NAME}'가 없습니다"
  echo "  │ 생성: kubectl apply -f k8s/projects/\${PROJ}/argo-appset.yaml -n \${ARGOCD_NS}"
fi

print_header "3. ApplicationSet 감시 경로 확인"
WATCH_PATH=\$(kubectl get applicationset \${APPSET_NAME} -n \${ARGOCD_NS} \\
  -o jsonpath='{.spec.generators[0].git.directories[0].path}' 2>/dev/null || echo "")
if [ -n "\${WATCH_PATH}" ]; then
  echo "  │ 감시 경로: \${WATCH_PATH}"
  if echo "\${WATCH_PATH}" | grep -q "\${SVC_PATH}"; then
    check_pass "감시 경로가 '\${SVC_PATH}/*' 와 일치"
  else
    check_fail "감시 경로 불일치: 예상='\${SVC_PATH}/*', 실제='\${WATCH_PATH}'"
  fi
else
  check_fail "ApplicationSet의 감시 경로를 조회할 수 없습니다"
fi

print_header "4. 자동 생성된 Application 목록"
APPS=\$(kubectl get applications -n \${ARGOCD_NS} -l grad-deploy/project=\${PROJ} \\
  -o custom-columns='NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status' 2>/dev/null)
if [ -n "\${APPS}" ]; then
  echo "\${APPS}" | sed 's/^/  │ /'
  APP_COUNT=\$(kubectl get applications -n \${ARGOCD_NS} -l grad-deploy/project=\${PROJ} -o name 2>/dev/null | wc -l | tr -d ' ')
  check_pass "\${APP_COUNT}개 Application 자동 생성됨"
else
  check_fail "프로젝트 '\${PROJ}'에 대한 Application이 없습니다"
  echo "  │ services/ 폴더에 서비스가 push 되었는지 확인하세요"
fi

print_header "5. Prune 동작 확인"
echo "  │ ApplicationSet syncPolicy 확인:"
kubectl get applicationset \${APPSET_NAME} -n \${ARGOCD_NS} \\
  -o jsonpath='  │   applicationsSync: {.spec.syncPolicy.applicationsSync}{"\\n"}  │   preserveResourcesOnDeletion: {.spec.syncPolicy.preserveResourcesOnDeletion}{"\\n"}' 2>/dev/null || echo "  │   (조회 실패)"
check_pass "Prune 설정 확인 완료 (위 값 참조)"

# ── 결과 요약 ────────────────────────────────────────
print_header "결과 요약"
echo "  ✅ PASS: \${PASS}"
echo "  ❌ FAIL: \${FAIL}"
if [ \${FAIL} -gt 0 ]; then
  echo ""
  echo "  🚫 FAIL이 있습니다. 위 항목을 해결한 뒤 다시 실행하세요."
  exit 1
else
  echo ""
  echo "  ✅ ApplicationSet 검증 완료!"
fi
`
}

// ── §2.4 장애 상태별 확인 루틴 문서 ──────────────────
// k8s/projects/<proj>/docs/troubleshooting-guide.md
export function genTroubleshootingGuide(proj, ns) {
  return `# Grad-Deploy 장애 상태별 확인 루틴

> Task 1 §2.4 — 각 상태별로 Argo CD UI에서 어디를 봐야 하는지와 kubectl 확인 명령을 정리합니다.

---

## 1. ImagePullBackOff

**증상**: Pod가 시작되지 않고 \`ImagePullBackOff\` 또는 \`ErrImagePull\` 상태

**Argo CD UI 확인 위치**:
- Applications → 해당 앱 클릭 → Pod 리소스 → Events 탭
- \`Failed to pull image\` 메시지 확인

**kubectl 확인 명령**:
\`\`\`bash
# Pod 이벤트 확인
kubectl describe pod <pod-name> -n ${ns} | grep -A5 Events

# 이미지 이름 확인
kubectl get pod <pod-name> -n ${ns} -o jsonpath='{.spec.containers[*].image}'

# imagePullSecret 확인
kubectl get pod <pod-name> -n ${ns} -o jsonpath='{.spec.imagePullSecrets}'

# GHCR 접근 테스트
docker pull <image-name>
\`\`\`

**주요 원인**:
- GHCR package가 private인데 imagePullSecret 미설정
- 이미지 태그 오타 (\`:latest\` vs \`:<commit-sha>\`)
- GitHub Actions 빌드 실패로 이미지가 push되지 않음

---

## 2. Pending

**증상**: Pod가 \`Pending\` 상태에서 스케줄링되지 않음

**Argo CD UI 확인 위치**:
- Applications → 해당 앱 → Pod 리소스 → Status: Pending
- Events 탭에서 \`FailedScheduling\` 메시지 확인

**kubectl 확인 명령**:
\`\`\`bash
# 스케줄링 실패 원인 확인
kubectl describe pod <pod-name> -n ${ns} | grep -A10 Events

# 노드 리소스 확인
kubectl top nodes

# ResourceQuota 사용량 확인
kubectl describe resourcequota -n ${ns}

# PVC 바인딩 상태 확인 (DB 서비스)
kubectl get pvc -n ${ns}
\`\`\`

**주요 원인**:
- 노드 리소스(CPU/메모리) 부족
- ResourceQuota 초과
- PersistentVolume 미할당 (DB 서비스)
- nodeSelector/affinity 조건 불일치

---

## 3. CrashLoopBackOff

**증상**: Pod가 반복적으로 시작/종료되며 \`CrashLoopBackOff\` 상태

**Argo CD UI 확인 위치**:
- Applications → 해당 앱 → Pod → Logs 탭
- Restart 횟수 확인 (RESTARTS 컬럼)

**kubectl 확인 명령**:
\`\`\`bash
# 컨테이너 로그 확인 (현재)
kubectl logs <pod-name> -n ${ns}

# 이전 실행 로그 확인 (크래시 직전)
kubectl logs <pod-name> -n ${ns} --previous

# 종료 코드 확인
kubectl get pod <pod-name> -n ${ns} -o jsonpath='{.status.containerStatuses[0].lastState.terminated}'

# 환경변수 확인
kubectl exec <pod-name> -n ${ns} -- env 2>/dev/null || true
\`\`\`

**주요 원인**:
- DB 연결 실패 (환경변수 오류 — DB_HOST, DB_PASSWORD 등)
- 포트 충돌 또는 바인딩 실패
- 애플리케이션 코드 오류
- Liveness Probe 실패로 반복 재시작

---

## 4. OOMKilled

**증상**: Pod가 \`OOMKilled\` 사유로 종료됨

**Argo CD UI 확인 위치**:
- Applications → 해당 앱 → Pod → Events 탭
- \`OOMKilled\` 메시지와 종료 코드 137 확인

**kubectl 확인 명령**:
\`\`\`bash
# OOMKilled 확인
kubectl get pod <pod-name> -n ${ns} -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}'

# 메모리 Limit 확인
kubectl get pod <pod-name> -n ${ns} -o jsonpath='{.spec.containers[0].resources.limits.memory}'

# 실시간 메모리 사용량
kubectl top pod <pod-name> -n ${ns}
\`\`\`

**주요 원인**:
- memory Limit이 너무 낮음 (특히 Elasticsearch, Java 앱)
- 메모리 누수
- ES_JAVA_OPTS 힙 크기가 memLim보다 큼

**해결 방법**:
- ServiceCard에서 memLim 값을 증가 (예: 512Mi → 1Gi)
- Elasticsearch: ES_JAVA_OPTS를 memReq의 50% 이하로 설정

---

## 5. OutOfSync

**증상**: Argo CD Application이 \`OutOfSync\` 상태

**Argo CD UI 확인 위치**:
- Applications → 해당 앱 → Sync Status: OutOfSync
- Diff 탭에서 Git과 클러스터 간 차이 확인
- Last Sync Result에서 실패 원인 확인

**kubectl 확인 명령**:
\`\`\`bash
# Application 상태 확인
kubectl get application ${proj}-<service> -n argocd -o jsonpath='{.status.sync}'

# 수동 Sync 실행
kubectl patch application ${proj}-<service> -n argocd --type merge \\
  -p '{"operation":{"sync":{"prune":true}}}'

# argocd CLI 사용
argocd app sync ${proj}-<service>
argocd app diff ${proj}-<service>
\`\`\`

**주요 원인**:
- Git 커밋 후 Argo CD가 아직 감지하지 못함 (polling 간격)
- Repository Secret 인증 실패
- ignoreDifferences 미설정으로 HPA replicas 등이 drift로 인식됨

---

## 6. Degraded

**증상**: Argo CD Application Health가 \`Degraded\` 상태

**Argo CD UI 확인 위치**:
- Applications → 해당 앱 → Health Status: Degraded
- 리소스 트리에서 빨간색 표시된 항목 클릭
- Readiness/Liveness Probe 실패 이벤트 확인

**kubectl 확인 명령**:
\`\`\`bash
# Deployment 상태 확인
kubectl rollout status deployment/<service-name> -n ${ns}

# ReplicaSet 확인
kubectl get rs -n ${ns} -l app=<service-name>

# Endpoint 확인 (Service에 Pod가 연결되었는지)
kubectl get endpoints <service-name> -n ${ns}

# Probe 실패 이벤트
kubectl get events -n ${ns} --field-selector reason=Unhealthy
\`\`\`

**주요 원인**:
- Readiness Probe 실패 (앱이 시작되었지만 준비되지 않음)
- 의존 서비스(DB)가 아직 Ready가 아닌 상태
- 잘못된 Probe 경로 (예: /healthz vs /health)

---

## 7. Progressing

**증상**: Argo CD Application Health가 \`Progressing\` 상태에서 멈춤

**Argo CD UI 확인 위치**:
- Applications → 해당 앱 → Health Status: Progressing
- Deployment 리소스 → rollout이 진행 중인지 확인
- Pod 상태가 \`Running\`으로 전환되는지 관찰

**kubectl 확인 명령**:
\`\`\`bash
# Deployment rollout 상태
kubectl rollout status deployment/<service-name> -n ${ns} --timeout=120s

# 새 ReplicaSet의 Pod 생성 상태
kubectl get rs -n ${ns} -l app=<service-name> --sort-by='.metadata.creationTimestamp'

# Startup Probe 진행 중 여부 확인
kubectl describe pod <pod-name> -n ${ns} | grep -A3 "Startup"
\`\`\`

**주요 원인**:
- Startup Probe \`failureThreshold\` × \`periodSeconds\`가 길어서 대기 중
- 새 이미지 Pull이 느림 (대용량 이미지)
- Rolling Update 중 — 정상적인 경우 일정 시간 후 Healthy로 전환됨

---

## 빠른 참조 — 장애 진단 순서

\`\`\`
1. Argo CD UI → Application 상태 확인 (Sync + Health)
2. kubectl get pods -n ${ns}  → Pod 상태 확인
3. kubectl describe pod <pod> -n ${ns}  → Events 확인
4. kubectl logs <pod> -n ${ns}  → 앱 로그 확인
5. kubectl get events -n ${ns} --sort-by='.lastTimestamp'  → 최근 이벤트
\`\`\`
`
}

// ── §2.2 + §4 Admin 운영 절차 + 체크리스트 통합 문서 ─
// k8s/projects/<proj>/docs/admin-ops-guide.md
export function genAdminOpsGuide(proj, ns) {
  const projectName = `${proj}-project`
  const appSetName  = `${proj}-appset`

  return `# Grad-Deploy Admin 운영 절차 가이드

> Task 1 §2.2 + §4 — 관리자가 Argo CD admin 대시보드에서 전체 상태를 확인하는 절차와 발표 당일 체크리스트를 정리합니다.

---

## 1. Argo CD Admin 접속 절차

### 1-1. 초기 비밀번호 확인

\`\`\`bash
kubectl -n argocd get secret argocd-initial-admin-secret \\
  -o jsonpath='{.data.password}' | base64 -d; echo
\`\`\`

> ⚠️ 최초 로그인 후 비밀번호를 변경하면 이 Secret은 삭제 가능합니다.
> 변경: \`argocd account update-password\`

### 1-2. 접속 URL 확보

**방법 A — port-forward (권장, 로컬)**:
\`\`\`bash
kubectl port-forward svc/argocd-server -n argocd 8080:443
# 접속: https://localhost:8080  (ID: admin)
\`\`\`

**방법 B — cloudflared tunnel (발표/외부 접속)**:
\`\`\`bash
cloudflared tunnel --url https://localhost:8080
# 생성된 https://xxx.trycloudflare.com URL 공유
\`\`\`

**방법 C — NodePort 변경**:
\`\`\`bash
kubectl patch svc argocd-server -n argocd -p '{"spec":{"type":"NodePort"}}'
kubectl get svc argocd-server -n argocd
\`\`\`

---

## 2. Admin 로그인 후 확인 메뉴

### 2-1. Applications
- 전체 Application 목록에서 Sync/Health 상태 확인
- 정상: 모든 앱이 \`Synced\` + \`Healthy\`
- \`${proj}-<서비스명>\` 형태로 서비스별 Application이 보여야 함

### 2-2. ApplicationSets
- Settings → ApplicationSets (또는 \`kubectl get applicationsets -n argocd\`)
- \`${appSetName}\` 이 존재하고, 감시 경로가 \`k8s/projects/${proj}/services/*\` 인지 확인

### 2-3. Projects
- Settings → Projects
- \`${projectName}\` 이 존재하고 sourceRepos, destinations 이 올바른지 확인

### 2-4. Repositories
- Settings → Repositories
- Git 저장소 URL이 등록되어 있고 CONNECTION STATUS가 \`Successful\` 인지 확인
- \`Failed\` 이면: PAT 만료, 저장소 삭제, URL 오타 등 점검

### 2-5. Settings
- Accounts: admin 외 추가 계정 확인
- Clusters: \`https://kubernetes.default.svc\` 연결 상태 확인

---

## 3. ApplicationSet 검증 체크리스트

| # | 검증 항목 | 확인 방법 | 정상 기준 |
|---|----------|----------|----------|
| 1 | AppProject가 먼저 생성됨 | \`kubectl get appproject ${projectName} -n argocd\` | 리소스 존재 |
| 2 | ApplicationSet이 services/* 감시 | \`kubectl get appset ${appSetName} -n argocd -o yaml\` → generators.git.directories.path | \`k8s/projects/${proj}/services/*\` |
| 3 | 서비스 폴더 추가 시 App 자동 생성 | Git push 후 Applications 목록 확인 | \`${proj}-<svc>\` 앱 생성됨 |
| 4 | 서비스 폴더 삭제 시 App 삭제 | 폴더 삭제 후 push → Applications 확인 | 해당 앱 삭제됨 (prune) |
| 5 | Sync 상태 | Applications → 각 앱의 Sync Status | Synced |
| 6 | Health 상태 | Applications → 각 앱의 Health Status | Healthy |
| 7 | Pod Ready | \`kubectl get pods -n ${ns}\` | 모든 Pod Running |

---

## 4. 실제 배포 루프 검증

최소 1회 이상 다음 흐름을 확인합니다:

\`\`\`
Git Push (main 브랜치)
  → GitHub Actions 워크플로우 실행 (이미지 빌드 + GHCR push)
    → kustomization.yaml 이미지 태그 자동 갱신
      → Argo CD 자동 Sync 감지
        → Pod Rolling Update
          → Pod Ready (Readiness Probe 통과)
\`\`\`

### 검증 명령:
\`\`\`bash
# GitHub Actions 상태 확인
gh run list --repo <owner>/<repo> --limit 3

# Argo CD Application sync 상태
kubectl get applications -n argocd -l grad-deploy/project=${proj}

# Pod 상태
kubectl get pods -n ${ns} -o wide

# 전체 이벤트 (최근 5분)
kubectl get events -n ${ns} --sort-by='.lastTimestamp' | tail -20
\`\`\`

---

## 5. 발표 당일 체크리스트

발표 시작 전 다음 항목을 순서대로 확인합니다.

### 사전 점검 (발표 30분 전)

- [ ] \`bash scripts/check-admin-cluster.sh\` 실행 — 모든 항목 PASS
- [ ] \`bash scripts/check-argocd-status.sh\` 실행 — admin 접속 확인
- [ ] \`bash scripts/check-applicationset.sh\` 실행 — ApplicationSet 정상
- [ ] Argo CD UI 접속 확인 (port-forward 또는 tunnel)
- [ ] 전체 Application이 Synced + Healthy 인지 확인
- [ ] Mini Board frontend에 브라우저로 접속 가능한지 확인

### 시연 중 장애 대응

- [ ] Pod가 비정상 → \`kubectl describe pod <pod> -n ${ns}\`
- [ ] Sync 실패 → Argo CD UI에서 Manual Sync 시도
- [ ] 이미지 Pull 실패 → imagePullSecret 확인
- [ ] 발표 중 URL 변경 → \`cloudflared tunnel\` 재시작

### 시연 후 정리

- [ ] 임시 port-forward / tunnel 종료
- [ ] 테스트 데이터 정리 (필요 시)

---

## 6. 스크립트 실행 순서

\`\`\`bash
# 1단계: 클러스터 환경 확인
bash scripts/check-admin-cluster.sh

# 2단계: Argo CD 상태 확인
bash scripts/check-argocd-status.sh

# 3단계: ApplicationSet 검증
bash scripts/check-applicationset.sh
\`\`\`

세 스크립트 모두 PASS이면 운영 환경이 정상입니다.
`
}

// ── 전체 파일 맵 빌드 (DeployPanel에서 호출) ──────────
//
// [변경] 파일 경로 계층 구조 (Multi-tenant 명명 규칙):
//
//   기존: k8s/base/<svcName>/         — 프로젝트 구분 없이 단일 레벨
//   변경: k8s/projects/<proj>/services/<svcName>/  — 프로젝트별 독립 경로
//
//   이유: 중앙 GitOps 레포(mono-repo)에 여러 팀이 공존할 때
//         팀A의 파일이 팀B의 파일을 덮어쓰는 경로 충돌을 방지.
//         ApplicationSet의 Git Generator도 이 경로 패턴을 감시함.
//
//   전체 디렉터리 규칙:
//     k8s/projects/<proj>/
//       ├── services/<svcName>/       ← 서비스 매니페스트 (Deployment, Service 등)
//       ├── overlays/production/      ← kustomize overlay (Ingress, NetworkPolicy)
//       ├── base/resource-quota.yaml  ← ResourceQuota + LimitRange
//       ├── argo-project.yaml         ← AppProject (1단계 수동 apply)
//       ├── argo-appset.yaml          ← ApplicationSet (2단계 수동 apply)
//       └── docs/deploy-order.md
//     k8s/argocd-admin/               ← Admin 전용 (argocd-cm, argocd-rbac-cm)
//     .github/workflows/              ← CI/CD
//     Dockerfile.<svcName>
export function buildAllFiles(services, cfg = {}) {
  const {
    ns             = 'default',
    proj           = 'my-app',
    repo           = 'https://github.com/ORG/REPO',
    registry       = 'ghcr',
    dockerhubUser  = '',
    cloud          = 'kind',
    workerCount    = 2,
    useLocalRegistry = false,
    registryPort   = 5001,
    // SSO 관련 파라미터 (역할2 — genArgoCDAdminConfig 로 전달)
    githubClientId = 'REPLACE_WITH_OAUTH_CLIENT_ID',
    argocdServer   = 'argocd.example.com',
    ssoTeams       = [],
    // ── [신규] 자격 증명 자동 생성을 위해 추가 ──
    pat            = '',
    ghUserLogin    = '',
  } = cfg

  // ── [수정] 대소문자 꼬임 방지를 위해 입력받은 Repo URL을 소문자로 정규화 ──
  const normalizedRepo = repo.toLowerCase();
  const pureRepoUrl = normalizedRepo.endsWith('.git') ? normalizedRepo.slice(0, -4) : normalizedRepo;
  const rawRepoUrl = pureRepoUrl.replace('github.com', 'raw.githubusercontent.com');

  // ── [변경] 프로젝트 루트 경로 — 모든 파일 경로의 기준점 ──
  // 중앙 레포에서 팀별 네임스페이스를 분리하는 핵심 규칙
  const projRoot   = ['k8s', 'projects', proj].join('/')   // 프로젝트 전용 루트
  const svcRoot    = [projRoot, 'services'].join('/')       // 서비스 매니페스트 루트 (ApplicationSet 감시 경로)
  const overlayDir = [projRoot, 'overlays', 'production'].join('/')
  const adminDir   = ['k8s', 'argocd-admin'].join('/')        // Admin 전용 — AppProject/sync 대상 제외

  // ── YAML 생성 ──────────────────────────────────────
  const netPolicyYaml     = genNetworkPolicies(services, ns)
  const ciYaml            = genGitHubActions(services, { proj, ns, registry, dockerhubUser, cloud })
  // Application: ApplicationSet이 서비스별 앱을 자동 생성하므로
  // 단일 Application은 "bootstrap" 용도로만 유지 (초기 수동 apply 불필요 시 삭제 가능)
  const argoAppYaml       = genArgoCDApp({ proj, repo: normalizedRepo, ns })
  const argoProjectYaml   = genAppProject(proj, ns, normalizedRepo)
  const argoAppSetYaml    = genApplicationSet({ proj, repo: normalizedRepo, ns, revision: 'HEAD' }) // [신규] ApplicationSet
  const argoParentAppYaml = genParentApp({ proj, repoUrl: pureRepoUrl })  // [신규] App-of-Apps 부모 Application
  const bootstrapYaml     = genAutopilotBootstrap(proj, normalizedRepo, ns) // [신규] Autopilot Bootstrap
  const resourceQuotaYaml = genResourceQuota(services, ns)
  // [역할2] genArgoCDAdminConfig: { cm, rbac, setup } 분리 반환
  // ssoTeams → dex teams[] + policy.csv g 규칙 동적 생성
  const adminConfig = genArgoCDAdminConfig({
    proj, ns, githubClientId, argocdServer,
    ssoTeams,  // DeployPanel SsoSetupSection 에서 전달
  })

  // ConfigMap / Secret / kustomization 파일 (envManager 연동)
  // 6번째 인수 proj: buildFileMap이 projRoot 기반 경로를 생성하도록 전달
  // buildFileMap(services, ns, netPolicy, ci, argoApp, proj) 시그니처와 반드시 일치
  const files = envBuildFileMap(services, ns, netPolicyYaml, ciYaml, argoAppYaml, proj)

  // ── [변경] 배포 순서: AppProject → ApplicationSet → ResourceQuota ──
  // (기존 argo-app.yaml 단독 방식 → ApplicationSet 방식으로 전환)
  files[[projRoot, 'argo-project.yaml'].join('/')]        = argoProjectYaml        // 1단계: AppProject
  files[[projRoot, 'argo-parent-app.yaml'].join('/')]      = argoParentAppYaml      // 2단계: 부모 Application [신규]
  files[[projRoot, 'argo-appset.yaml'].join('/')]          = argoAppSetYaml         // 3단계: ApplicationSet
  files[[projRoot, 'argo-app.yaml'].join('/')]             = argoAppYaml            // (레거시 참조용)
  files[[projRoot, 'base', 'resource-quota.yaml'].join('/')]  = resourceQuotaYaml     // [변경] projRoot 하위로 이동
  files[[projRoot, 'docs', 'bootstrap.yaml'].join('/')]        = bootstrapYaml;         // [신규] Autopilot 루트

  // ── [옵션 A] 부트스트랩 명령어 고도화 ──────────────────
  // 1. ArgoCD가 Private 레포를 긁어갈 수 있도록 PAT 을 담은 Secret 을 선언적으로 생성
  // 2. ArgoCD 가 Repository Secret 을 인식할 때까지 대기 (race condition 방지)
  // 3. AppProject 및 ApplicationSet 선언적 적용
  //
  // ⚠️ Repository 등록의 단일 책임 원칙 (옵션 A):
  //   bootstrap.sh 에서만 ArgoCD Repository 를 등록합니다.
  //   GitHub Actions 워크플로우의 'Register Repo to ArgoCD' 스텝은 제거되었습니다.
  //   (중복 등록 시 "existing repository spec is different" 충돌 발생)
  //
  // ── [수정] .git 접두사를 강제하지 않고 순수 URL 로 통일하여 자격증명 불일치 방지

  const bootstrapCmd = `#!/bin/bash
# ════════════════════════════════════════════════════════
#  Grad-Deploy 부트스트랩 — 최초 1회 실행
#
#  실행 흐름:
#    1단계: ArgoCD 에 Git Repository 자격증명 등록 (Secret 방식)
#    2단계: Secret 인식 대기 + 연결 상태 검증
#    3단계: AppProject, ApplicationSet 선언적 적용
#
#  ⚠️ 보안 주의:
#     이 파일에는 PAT 이 평문으로 박혀 있습니다.
#     Git 에 커밋하지 말고, 실행 후 즉시 삭제하세요.
# ════════════════════════════════════════════════════════
set -euo pipefail

PROJ="${proj}"
ARGOCD_NS="argocd"
SECRET_NAME="\${PROJ}-git-repo-creds"

echo "▶ 1단계: Git Repository 자격증명 Secret 생성"
# type=git 필드는 ArgoCD 가 Helm/OCI 등 다른 타입과 구분하기 위해 필수입니다.
# 누락되면 Repository 가 인식되지 않거나 잘못된 타입으로 등록될 수 있습니다.
kubectl create secret generic "\${SECRET_NAME}" \\
  -n "\${ARGOCD_NS}" \\
  --from-literal=type="git" \\
  --from-literal=url="${pureRepoUrl}" \\
  --from-literal=username="${ghUserLogin}" \\
  --from-literal=password="${pat}" \\
  --dry-run=client -o yaml | kubectl apply -f -

# ArgoCD 가 이 Secret 을 Repository 로 인식하도록 레이블 지정
kubectl label secret "\${SECRET_NAME}" \\
  -n "\${ARGOCD_NS}" \\
  argocd.argoproj.io/secret-type=repository \\
  --overwrite

echo ""
echo "▶ 2단계: ArgoCD Repository 인식 대기 (최대 30초)"
# ArgoCD 가 Secret 을 polling 해서 인식할 때까지 대기.
# 이 대기 없이 바로 ApplicationSet 을 apply 하면, ApplicationSet 이
# repo polling 을 시도할 때 인증 정보가 아직 로드되지 않아
# CONNECTION STATUS=Failed 가 박힐 수 있습니다.
for i in {1..15}; do
  LABEL=\$(kubectl get secret "\${SECRET_NAME}" -n "\${ARGOCD_NS}" \\
    -o jsonpath='{.metadata.labels.argocd\\.argoproj\\.io/secret-type}' 2>/dev/null || echo "")
  if [ "\${LABEL}" = "repository" ]; then
    echo "  ✓ Repository Secret 인식 완료"
    break
  fi
  echo "  ... 대기 중 (\${i}/15)"
  sleep 2
done

echo ""
echo "▶ 3단계: AppProject + ApplicationSet 적용"
# Private 레포지토리의 경우 kubectl apply -f <URL> 이 실패하므로 curl + PAT 헤더 사용.
# -f: HTTP 4xx/5xx 응답 시 즉시 실패 (PAT 만료/스코프 부족 조기 감지)
# -S: 에러 메시지 표시
# -L: redirect 추적
curl -fsSL -H "Authorization: token ${pat}" \\
  "${rawRepoUrl}/main/k8s/projects/${proj}/argo-project.yaml" \\
  | kubectl apply -n "\${ARGOCD_NS}" -f -

curl -fsSL -H "Authorization: token ${pat}" \\
  "${rawRepoUrl}/main/k8s/projects/${proj}/argo-appset.yaml" \\
  | kubectl apply -n "\${ARGOCD_NS}" -f -

echo ""
echo "✅ 부트스트랩 완료"
echo ""
echo "📌 다음 단계 — 연결 상태 확인:"
echo "   1. ArgoCD UI → Settings → Repositories 접속"
echo "   2. '${pureRepoUrl}' 의 CONNECTION STATUS 가 'Successful' 이어야 정상"
echo ""
echo "🔧 만약 CONNECTION STATUS=Failed 라면:"
echo "   # repo-server 로그 확인 (인증 실패의 실제 원인이 여기 찍힘)"
echo "   kubectl logs -n \${ARGOCD_NS} -l app.kubernetes.io/name=argocd-repo-server --tail=50"
echo ""
echo "   # PAT 직접 검증 (Private repo 접근 가능 여부)"
echo "   curl -fsSL -H 'Authorization: token <PAT>' ${rawRepoUrl}/main/README.md"
echo ""
echo "🔒 보안: 이 bootstrap.sh 파일을 즉시 삭제하세요 (PAT 평문 노출)."
echo "   rm k8s/projects/\${PROJ}/docs/bootstrap.sh"
`;


  // ── [보안] bootstrap.sh 는 Git 에 커밋하지 않습니다 ──────
  // 이전 코드는 files[...bootstrap.sh] 로 GitHub 에 푸시했으나
  // PAT 평문이 포함된 채로 GitHub Push Protection 에 차단되어
  // HTTP 409 "Repository rule violations found: Secret detected in content"
  // 가 발생했습니다.
  //
  // bootstrap.sh 는 로컬에서 1회만 실행되는 셸 스크립트이므로
  // 다음 경로로만 사용자에게 노출됩니다:
  //   1) DeployPanel 의 results.bootstrapCmd 로 화면 표시
  //   2) 클립보드 복사 버튼으로 사용자가 직접 복사 → 로컬 실행
  //
  // → files map 에는 추가하지 않음 (Git push 대상에서 제외)
  // files[[projRoot, 'docs', 'bootstrap.sh'].join('/')] = bootstrapCmd;  // [제거됨]

  // ssoTeams에 명시된 다른 프로젝트들의 AppProject도 함께 생성 (플랫폼 Admin 설정의 일환)
  if (ssoTeams.length > 0) {
    ssoTeams.forEach(t => {
      if (t.proj && t.proj !== proj && t.ns) {
        files[['k8s', 'projects', t.proj, 'argo-project.yaml'].join('/')] = genAppProject(t.proj, t.ns, normalizedRepo)
      }
    })
  }

  // ── [역할2] Admin 전용 파일 — 각각 독립 경로에 저장 ──
  // argocd namespace 에 수동 apply (ApplicationSet sync 대상 아님)
  // 파일 분리 이유:
  //   - argocd-cm.yaml / argocd-rbac-cm.yaml 을 각각 apply 해야
  //     Argo CD 가 개별 ConfigMap 으로 인식함
  //   - setup.sh 는 실행 권한 필요 (chmod +x 후 bash 실행)
  files[[adminDir, 'argocd-cm.yaml'].join('/')]      = adminConfig.cm
  files[[adminDir, 'argocd-rbac-cm.yaml'].join('/')]  = adminConfig.rbac
  files[[adminDir, 'setup.sh'].join('/')]             = adminConfig.setup
  files[[adminDir, 'test-rbac.sh'].join('/')]         = adminConfig.testRbac

  // ── [변경] 서비스별 Deployment + Service 파일 ──────
  // 경로: k8s/projects/<proj>/services/<svcName>/
  // ApplicationSet의 Git Generator가 이 경로를 폴더 단위로 스캔함
  services.forEach(svc => {
    const base = [svcRoot, svc.name].join('/')   // [변경] projRoot 기반 경로
    files[[base, 'deployment.yaml'].join('/')] = genDeployment(svc, ns, cloud)
    files[[base, 'service.yaml'].join('/')]    = genService(svc, ns, cloud)

    const hpa = genHPA(svc, ns)
    if (hpa) files[[base, 'hpa.yaml'].join('/')] = hpa

    const nginxConf = genNginxConf(svc, services, ns)
    if (nginxConf) files[[base, 'nginx-conf.yaml'].join('/')] = nginxConf

    files[`Dockerfile.${svc.name}`] = getDockerfileContent(svc, cloud)
  })

  // ── kind 전용 파일 ─────────────────────────────────
  if (cloud === 'kind' || cloud === 'local') {
    const ingressYaml = genIngress(services, ns, cloud)
    if (ingressYaml) {
      files[[overlayDir, 'ingress.yaml'].join('/')] = ingressYaml  // [변경] projRoot 기반 경로
    }

    files['kind-config.yaml'] = genKindConfig({
      workerCount,
      useLocalRegistry,
      registryPort,
      exposeIngress: services.some(s => s.expose),
    })

    if (useLocalRegistry) {
      files[['scripts', 'setup-kind-registry.sh'].join('/')] = genLocalRegistryScript({
        registryPort,
        clusterName: proj || 'grad-deploy',
      })
    }

    const ingressReadme = genIngressSetupReadme(cloud, proj)  // proj 전달: README 내 경로를 신 경로로 생성
    if (ingressReadme) {
      files[[projRoot, 'docs', 'ingress-setup.md'].join('/')] = ingressReadme
    }
  }

  // 배포 순서 안내 README — ApplicationSet 흐름으로 업데이트됨
  files[[projRoot, 'docs', 'deploy-order.md'].join('/')] = genDeployOrderReadme(proj, ns)  // [변경] projRoot 하위

  // ── [Task 1] 운영 환경 검증 산출물 ─────────────────
  // §2.1 클러스터 환경 확인 스크립트
  files['scripts/check-admin-cluster.sh']    = genCheckAdminCluster(proj, ns)
  // §2.2 Argo CD admin 상태 확인 스크립트
  files['scripts/check-argocd-status.sh']    = genCheckArgoCDStatus(proj, ns)
  // §2.3 ApplicationSet 검증 스크립트
  files['scripts/check-applicationset.sh']   = genCheckApplicationSet(proj, ns)
  // §2.4 장애 상태별 확인 루틴 문서
  files[[projRoot, 'docs', 'troubleshooting-guide.md'].join('/')] = genTroubleshootingGuide(proj, ns)
  // §2.2 + §4 Admin 운영 절차 + 체크리스트 통합 문서
  files[[projRoot, 'docs', 'admin-ops-guide.md'].join('/')]       = genAdminOpsGuide(proj, ns)

  return files
}

// ── 기존 함수 (하위 호환) ─────────────────────────────
export function genBaseKustomization(svc) {
  const hasSecret = Object.keys(svc.env || {}).some(k => isSensKey(k))
  const isNginxType = (svc.type === 'nginx' || svc.type === 'react-nginx')
  const resources = ['deployment.yaml', 'service.yaml', 'configmap.yaml']
  if (isNginxType) resources.push('nginx-conf.yaml')
  if (hasSecret) resources.push('secret.yaml')
  return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
${resources.map(r => `  - ${r}`).join('\n')}`
}

export function genOverlayKustomization(services, ns, cloud = 'kind') {
  const imageNameOf = name => name.replace(/-svc$/, '-service-v2')
  const hasIngress = services.some(s => {
    const t = SERVICE_TEMPLATES[s.type] || {}
    return s.expose && !t.isDB && (cloud === 'kind' || cloud === 'local')
  })
  // 상대경로:
  //   이 파일 위치 = overlays/production/kustomization.yaml
  //   서비스 위치  = services/{svcName}/
  //   → overlays/production/ 기준으로 ../../services/{svcName}
  return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ${ns}
resources:
${services.map(s => `  - ../../services/${s.name}`).join('\n')}
  - networkpolicy.yaml${hasIngress ? '\n  - ingress.yaml' : ''}
images:
${services.map(s => `  - name: ${s.name}
    newName: ${imageNameOf(s.name)}`).join('\n')}`
}

// ── Dockerfile ────────────────────────────────────────
function getImageForService(svc) {
  if (svc.image) return svc.image
  const t = SERVICE_TEMPLATES[svc.type] || {}
  if (t.isDB) {
    if (svc.type === 'mysql')         return 'mysql:8.0'
    if (svc.type === 'postgresql')    return 'postgres:16-alpine'
    if (svc.type === 'redis')         return 'redis:7-alpine'
    if (svc.type === 'mongodb')       return 'mongo:7.0'
    if (svc.type === 'elasticsearch') return 'docker.elastic.co/elasticsearch/elasticsearch:8.12.0'
  }
  return `${svc.type}:latest`
}

function getDockerfileContent(svc, cloud = 'kind') {
  const baseImage = getImageForService(svc)
  const t = SERVICE_TEMPLATES[svc.type] || {}

  // DB 타입별 커스텀 Dockerfile
  // Elasticsearch는 단순 FROM으로는 메모리 설정 없이 시작되어 OOM 발생 가능
  if (t.isDB) {
    if (svc.type === 'elasticsearch') {
      return `# Elasticsearch — kind 환경용 단일 노드 설정
# 실제 ELASTIC_PASSWORD는 secret.yaml에서 환경변수로 주입됨
FROM ${baseImage}
# 필수 환경변수는 K8s ConfigMap/Secret envFrom으로 주입
# ENV discovery.type=single-node   ← deployment.yaml에서 설정
# ENV ES_JAVA_OPTS="-Xms512m -Xmx512m"  ← deployment.yaml에서 설정
EXPOSE 9200 9300`
    }
    return `FROM ${baseImage}`
  }

  // kind / local: 로컬 레지스트리 이미지 경로 안내 주석 추가
  const registryHint = (cloud === 'kind' || cloud === 'local')
    ? `# kind 로컬 레지스트리 사용 시 빌드 & 푸시:\n# docker build -t localhost:5001/${svc.name}:latest .\n# docker push localhost:5001/${svc.name}:latest\n# 그리고 deployment.yaml의 image를 localhost:5001/${svc.name}:latest 로 변경\n`
    : ''

  switch (svc.type) {
    case 'spring-boot':
      return `${registryHint}FROM ${baseImage}
WORKDIR /app
# 실제 JAR로 교체: COPY build/libs/*.jar app.jar
# ENTRYPOINT ["java", "-jar", "app.jar"]
RUN apk add --no-cache curl
EXPOSE ${svc.port || t.port || 8080}
CMD ["sh", "-c", "while true; do sleep 30; done"]`

    case 'node-backend':
return `${registryHint}FROM ${baseImage}
WORKDIR /app
RUN echo '{"name":"node-svc","version":"1.0.0"}' > package.json && \\
    printf 'const http=require("http");\\nhttp.createServer((_,r)=>{r.writeHead(200);r.end("ok")}).listen(${svc.port || t.port || 3000})\\n' > index.js
EXPOSE ${svc.port || t.port || 3000}
CMD ["node", "index.js"]`

    case 'python-flask': {
      const port = svc.port || t.port || 5000
      return `${registryHint}FROM ${baseImage}
WORKDIR /app
RUN pip install --no-cache-dir flask
RUN printf 'from flask import Flask\\napp=Flask(__name__)\\n@app.route("/")\\ndef h():return "ok"\\nif __name__=="__main__":app.run(host="0.0.0.0",port=${port})\\n' > main.py
EXPOSE ${port}
CMD ["python", "main.py"]`
    }

    case 'nextjs': {
      const port = svc.port || t.port || 3000
      // NEXT_PUBLIC_ 접두사 환경변수 추출 (빌드 시점 주입 필요)
      const env = svc.env || {}
      const publicEnvKeys = Object.keys(env).filter(k => k.startsWith('NEXT_PUBLIC_'))
      // Docker ARG → ENV 변환 블록 생성
      const buildArgLines = publicEnvKeys.length > 0
        ? '\n# ⚠️ NEXT_PUBLIC_ 변수: 빌드 시점에 JS 번들에 인라인됨\n'
          + '# docker build --build-arg NEXT_PUBLIC_API_URL=... 형태로 전달 필요\n'
          + publicEnvKeys.map(k => `ARG ${k}\nENV ${k}=\$\{${k}\}`).join('\n')
          + '\n'
        : ''
      // 서버 사이드 전용 변수 안내 (NEXT_PUBLIC_ 아닌 변수)
      const serverOnlyKeys = Object.keys(env).filter(k => !k.startsWith('NEXT_PUBLIC_'))
      const serverOnlyComment = serverOnlyKeys.length > 0
        ? `\n# 서버 전용 변수 (런타임 주입 — ConfigMap/Secret envFrom으로 자동 주입됨):\n`
          + `# ${serverOnlyKeys.join(', ')}\n`
        : ''

      return `${registryHint}# ── Next.js standalone 빌드 ──────────────────────────
# output: 'standalone' 설정으로 경량 프로덕션 이미지 생성
# next.config.js에 output: 'standalone' 추가 필요
#
# ⚠️ Next.js 환경변수 주입 규칙:
#   - NEXT_PUBLIC_* : 빌드 시점에 JS 번들에 포함됨 → Docker ARG로 전달 필수
#   - 그 외 변수    : 런타임에 server.js가 읽음 → K8s ConfigMap/Secret envFrom으로 주입
#
# ⚠️ 포트 일관성:
#   PORT 환경변수 = containerPort = livenessProbe/readinessProbe 포트
#   이 세 값이 일치하지 않으면 헬스체크 실패로 Pod가 재시작됩니다.
${serverOnlyComment}
# 1단계: 의존성 설치
FROM ${baseImage} AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --only=production

# 2단계: 빌드
FROM ${baseImage} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
${buildArgLines}# next.config.js에 output: 'standalone'이 설정되어 있어야 합니다
RUN npm run build

# 3단계: 프로덕션 실행
FROM ${baseImage} AS runner
WORKDIR /app
ENV NODE_ENV=production
# ⚠️ PORT=${port} — K8s containerPort·Probe와 반드시 동일해야 합니다
ENV PORT=${port}
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE ${port}
# standalone 서버 실행 (server.js는 next build가 자동 생성)
CMD ["node", "server.js"]`
    }

    case 'react-nginx':
return `${registryHint}FROM ${baseImage}
RUN echo '<html><body><h1>${svc.name}</h1><p>Powered by Grad-Deploy</p></body></html>' > /usr/share/nginx/html/index.html
EXPOSE ${svc.port || t.port || 80}`

    default:
      return `${registryHint}FROM ${baseImage}`
  }
}
