// ══════════════════════════════════════════════════════
//  Grad-Deploy v2  ·  K8s 매니페스트 생성기
//  - kind 클러스터 지원 (Ingress·AntiAffinity·LocalRegistry)
//  - ConfigMap / Secret 파일 분리 (envManager 연동)
//  - buildAllFiles: 전체 파일 맵 빌드 (DeployPanel 호출용)
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
export function genIngressSetupReadme(cloud = 'kind') {
  if (cloud !== 'kind' && cloud !== 'local') return null
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

Grad-Deploy가 자동 생성한 \`k8s/overlays/production/ingress.yaml\`을 확인하세요.
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

  const isGHCR = registry === 'ghcr'
  const imageNameOf = name => name.replace(/-svc$/, '-service-v2')
  const imagePath = svcName => isGHCR
    ? `ghcr.io/\${{ github.repository_owner }}/${imageNameOf(svcName)}`
    : `docker.io/${dockerhubUser || '${{ secrets.DOCKERHUB_USERNAME }}'}/${imageNameOf(svcName)}`

  const loginBlock = isGHCR
    ? `      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}`
    : `      - name: Login to Docker Hub
        uses: docker/login-action@v3
        with:
          username: \${{ secrets.DOCKERHUB_USERNAME }}
          password: \${{ secrets.DOCKERHUB_TOKEN }}`

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
            `            ${k}=\${{ vars.${k} }}`
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
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
        with:
          token: \${{ secrets.GITHUB_TOKEN }}

      - name: Check for plain text Secrets
        run: |
          if grep -r "^kind: Secret" k8s/ --include="*.yaml" 2>/dev/null | grep -v "SealedSecret"; then
            echo "::error::평문 Secret이 발견되었습니다. SealedSecret을 사용하세요."
            exit 1
          fi
          echo "✅ 평문 Secret 없음"

      - name: Update image tags in kustomization
        run: |
${appServices.map(svc => {
    const imgPath = imagePath(svc.name)
    return `          cd k8s/overlays/production
          sed -i "s|newTag: .*|newTag: \${{ github.sha }}|g" kustomization.yaml || true`
  }).join('\n')}
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add k8s/overlays/production/kustomization.yaml
          git diff --staged --quiet || git commit -m "ci: update image tags [\${{ github.sha }}]"
          git push

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
export function genArgoApplication(appName, repoUrl, targetRevision, path, ns) {
  return `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${appName}
  namespace: argocd
spec:
  project: default
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
    retry:
      limit: 5
      backoff: { duration: 5s, factor: 2, maxDuration: 3m }
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers: [/spec/replicas]`
}

export function genArgoCDApp(cfg = {}) {
  const { proj = 'my-app', repo = 'https://github.com/ORG/REPO', ns = 'default' } = cfg
  return genArgoApplication(proj, repo, 'HEAD', 'k8s/overlays/production', ns)
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

// ── 전체 파일 맵 빌드 (DeployPanel에서 호출) ──────────
export function buildAllFiles(services, cfg = {}) {
  const {
    ns = 'default',
    proj = 'my-app',
    repo = 'https://github.com/ORG/REPO',
    registry = 'ghcr',
    dockerhubUser = '',
    cloud = 'kind',
    workerCount = 2,
    useLocalRegistry = false,
    registryPort = 5001,
  } = cfg

  const netPolicyYaml = genNetworkPolicies(services, ns)
  const ciYaml = genGitHubActions(services, { proj, ns, registry, dockerhubUser, cloud })
  const argoYaml = genArgoCDApp({ proj, repo, ns })

  // ConfigMap / Secret / kustomization 파일
  const files = envBuildFileMap(services, ns, netPolicyYaml, ciYaml, argoYaml)

  // 서비스별 Deployment + Service 파일 추가
  services.forEach(svc => {
    const base = `k8s/base/${svc.name}`
    files[`${base}/deployment.yaml`] = genDeployment(svc, ns, cloud)
    files[`${base}/service.yaml`] = genService(svc, ns, cloud)

    const hpa = genHPA(svc, ns)
    if (hpa) files[`${base}/hpa.yaml`] = hpa

    // nginx / react-nginx: nginx.conf ConfigMap 별도 생성
    const nginxConf = genNginxConf(svc, services, ns)
    if (nginxConf) {
      files[`${base}/nginx-conf.yaml`] = nginxConf
    }

    files[`Dockerfile.${svc.name}`] = getDockerfileContent(svc, cloud)
  })

  // ── kind 전용 파일 ─────────────────────────────────
  if (cloud === 'kind' || cloud === 'local') {
    // Ingress 매니페스트
    const ingressYaml = genIngress(services, ns, cloud)
    if (ingressYaml) {
      files['k8s/overlays/production/ingress.yaml'] = ingressYaml
    }

    // kind 클러스터 설정
    files['kind-config.yaml'] = genKindConfig({
      workerCount,
      useLocalRegistry,
      registryPort,
      exposeIngress: services.some(s => s.expose),
    })

    // 로컬 레지스트리 셋업 스크립트
    if (useLocalRegistry) {
      files['scripts/setup-kind-registry.sh'] = genLocalRegistryScript({
        registryPort,
        clusterName: proj || 'grad-deploy',
      })
    }

    // Ingress 설치 안내
    const ingressReadme = genIngressSetupReadme(cloud)
    if (ingressReadme) {
      files['docs/ingress-setup.md'] = ingressReadme
    }
  }

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
  return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ${ns}
resources:
${services.map(s => `  - ../../base/${s.name}`).join('\n')}
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
