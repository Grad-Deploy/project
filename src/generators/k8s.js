// ══════════════════════════════════════════════════════
//  Grad-Deploy v2  ·  K8s 매니페스트 생성기
// ══════════════════════════════════════════════════════

import { SERVICE_TEMPLATES } from '../engines/guardrail'

const SENS = /password|secret|token|key|auth|credential/i

// exec probe YAML 블록 생성 헬퍼
function execProbeYaml(cmd, ft, ps, periodSeconds, failureThreshold) {
  const cmdLines = cmd.map(c => `              - "${c}"`).join('\n')
  return `exec:
              command:
${cmdLines}
            failureThreshold: ${failureThreshold}
            periodSeconds: ${periodSeconds}`
}

// httpGet probe YAML 블록 생성 헬퍼
function httpProbeYaml(path, port, periodSeconds, failureThreshold) {
  return `httpGet:
              path: ${path}
              port: ${port}
            periodSeconds: ${periodSeconds}
            failureThreshold: ${failureThreshold}`
}

function genDeployment(svc, ns) {
  const t = SERVICE_TEMPLATES[svc.type] || {}
  const isDB = !!t.isDB
  const kind = isDB ? 'StatefulSet' : 'Deployment'
  const port = svc.port || t.port || 8080
  const img = svc.image || `${svc.name}:latest`
  const cpuR = svc.cpuReq || t.cpuReq || '100m'
  const memR = svc.memReq || t.memReq || '256Mi'
  const memL = svc.memLim || t.memLim || '512Mi'
  const cpuL = svc.cpuLim || t.cpuLim

  // DB는 exec probe, 일반 서비스는 httpGet probe
  let startupProbe, livenessProbe, readinessProbe

  if (isDB && t.probeExec) {
    const cmd = t.probeExec
    startupProbe = execProbeYaml(cmd, t.startupFT || 10, t.startupPS || 5, t.startupPS || 5, t.startupFT || 10)
    livenessProbe = execProbeYaml(cmd, 3, 30, 30, 3)
    readinessProbe = execProbeYaml(cmd, 3, 10, 10, 3)
  } else {
    const lv = svc.liveness || t.liveness || '/healthz'
    const rd = svc.readiness || t.readiness || '/ready'
    startupProbe = httpProbeYaml(lv, port, t.startupPS || 5, t.startupFT || 10)
    livenessProbe = httpProbeYaml(lv, port, 30, 3)
    readinessProbe = httpProbeYaml(rd, port, 10, 3)
  }

  // DB StatefulSet은 root 권한 필요한 경우가 많아 securityContext 완화
  const securityCtx = isDB
    ? `runAsUser: 999`
    : `runAsNonRoot: true
        runAsUser: 1000`

  return `apiVersion: apps/v1
kind: ${kind}
metadata:
  name: ${svc.name}
  namespace: ${ns}
  labels:
    app: ${svc.name}
    app.kubernetes.io/managed-by: grad-deploy
spec:
  ${isDB ? `serviceName: ${svc.name}` : `replicas: ${svc.replicas || 1}`}
  selector:
    matchLabels:
      app: ${svc.name}
  template:
    metadata:
      labels:
        app: ${svc.name}
    spec:
      securityContext:
        ${securityCtx}
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
                optional: true
          startupProbe:
            ${startupProbe}
          livenessProbe:
            ${livenessProbe}
          readinessProbe:
            ${readinessProbe}${isDB ? `
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: "${svc.storageClass || 'standard'}"
        resources:
          requests:
            storage: ${svc.storageSize || '10Gi'}` : ''}`
}

function genService(svc, ns) {
  const t = SERVICE_TEMPLATES[svc.type] || {}
  const port = svc.port || t.port || 8080
  return `apiVersion: v1
kind: Service
metadata:
  name: ${svc.name}
  namespace: ${ns}
spec:
  ${t.isDB ? 'clusterIP: None' : `type: ${svc.expose ? 'LoadBalancer' : 'ClusterIP'}`}
  selector:
    app: ${svc.name}
  ports:
    - port: ${port}
      targetPort: ${port}`
}

function genConfigMap(svc, ns) {
  const entries = Object.entries(svc.env || {}).filter(([k]) => !SENS.test(k))
  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${svc.name}-config
  namespace: ${ns}
data:
${entries.length ? entries.map(([k, v]) => `  ${k}: "${v}"`).join('\n') : '  # 없음'}`
}

function genSecret(svc, ns) {
  const entries = Object.entries(svc.env || {}).filter(([k]) => SENS.test(k))
  if (!entries.length) return null
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${svc.name}-secret
  namespace: ${ns}
type: Opaque
stringData:
${entries.map(([k]) => `  ${k}: "\${{ secrets.${k.toUpperCase()} }}"`).join('\n')}`
}

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

export function genGitHubActions(services, cfg = {}) {
  const {
    proj = 'my-app',
    ns = 'default',
    registry = 'ghcr',           // 'ghcr' | 'dockerhub'
    dockerhubUser = '',
  } = cfg

  // 레지스트리별 설정
  const isGHCR = registry === 'ghcr'
  const registryHost = isGHCR ? 'ghcr.io' : 'docker.io'

  // 이미지 경로: GHCR은 소문자 OWNER/repo, Docker Hub는 사용자명/repo
  // GHCR: ghcr.io/${{ github.repository_owner }}/mysql-service-v2
  // Docker Hub: docker.io/dockerhubUser/mysql-service-v2
  const imageNameOf = name => name.replace(/-svc$/, '-service-v2')
  const imagePath = svcName => isGHCR
    ? `ghcr.io/\${{ github.repository_owner }}/${imageNameOf(svcName)}`
    : `docker.io/${dockerhubUser || '${{ secrets.DOCKERHUB_USERNAME }}'}/${imageNameOf(svcName)}`

  // 로그인 블록
  const loginBlock = `      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io            # 반드시 ghcr.io를 명시해야 합니다
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}`

  // 권한 블록 (GHCR은 packages: write 필요)
  const permissionsBlock = isGHCR
    ? `permissions:
  contents: write
  packages: write
`
    : `permissions:
  contents: write
`

  return `name: "Grad-Deploy CI — ${proj}"

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

${permissionsBlock}
jobs:
${services.map(s => `  build-${s.name}:
    name: "Build & Push — ${s.name}"
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      # Dockerfile이 없으면 자동 생성 (서비스 타입별 실행 가능한 내용 포함)
      - name: Ensure Dockerfile
        run: |
          mkdir -p ./${s.name}
          if [ ! -f ./${s.name}/Dockerfile ]; then
            cat > ./${s.name}/Dockerfile <<'DOCKERFILE'
          ${getDockerfileContent(s).split('\n').join('\n          ')}
          DOCKERFILE
            echo "Dockerfile auto-generated for ${s.name}"
          fi

      - name: Docker meta
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${imagePath(s.name)}
          tags: |
            type=sha,format=short
            type=raw,value=latest,enable=\${{ github.ref == 'refs/heads/main' }}

${loginBlock}

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build & Push
        uses: docker/build-push-action@v5
        with:
          context: ./${s.name}
          push: true
          tags: \${{ steps.meta.outputs.tags }}
          cache-from: type=registry,ref=${imagePath(s.name)}:cache
          cache-to: type=registry,ref=${imagePath(s.name)}:cache,mode=max,image-manifest=true,oci-mediatypes=true`).join('\n\n')}

  validate:
    name: "Manifest Validation"
    runs-on: ubuntu-latest
    needs: [${services.map(s => `build-${s.name}`).join(', ')}]
    steps:
      - uses: actions/checkout@v4
      - name: Kubeval
        run: |
          curl -sL https://github.com/instrumenta/kubeval/releases/latest/download/kubeval-linux-amd64.tar.gz | tar xz
          sudo mv kubeval /usr/local/bin
          find k8s -name "*.yaml" | xargs kubeval --strict --ignore-missing-schemas

  update-tags:
    name: "Update Image Tags (GitOps)"
    runs-on: ubuntu-latest
    needs: [validate]
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
        with:
          token: \${{ secrets.GITHUB_TOKEN }}
          fetch-depth: 0
      - name: Install kustomize
        run: |
          curl -sL "https://raw.githubusercontent.com/kubernetes-sigs/kustomize/master/hack/install_kustomize.sh" | bash
          sudo mv kustomize /usr/local/bin/
      - name: Update image tags
        run: |
          SHA=\$(echo "\${{ github.sha }}" | cut -c1-7)
          cd k8s/overlays/production
${services.map(s => `          kustomize edit set image ${s.name}=${imagePath(s.name)}:\${SHA}`).join('\n')}
      - name: Commit & Push changes
        uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: "chore: update image tags [skip ci]"
          branch: main
          push_options: '--force'
          file_pattern: "k8s/overlays/production/kustomization.yaml"
          skip_dirty_check: false

  sync-argocd:
    name: "플랫폼 등록 서비스 — Application 등록 & Sync (US-03)"
    runs-on: ubuntu-latest
    needs: [update-tags]
    if: vars.REGISTER_URL != ''
    steps:
      - name: Application 등록 및 Sync 트리거
        env:
          REGISTER_URL: \${{ vars.REGISTER_URL }}
          REGISTER_SECRET: \${{ secrets.REGISTER_SECRET }}
        run: |
          REPO_URL="\${GITHUB_SERVER_URL}/\${GITHUB_REPOSITORY}"

          echo "=== 플랫폼 등록 서비스 호출 ==="
          echo "URL  : \${REGISTER_URL}/register"
          echo "App  : ${proj}"
          echo "NS   : ${ns}"
          echo "Repo : \${REPO_URL}"

          HTTP_STATUS=\$(curl -s -o /tmp/reg_resp.json -w "%{http_code}" \\
            -X POST "\${REGISTER_URL}/register" \\
            -H "X-Register-Secret: \${REGISTER_SECRET}" \\
            -H "Content-Type: application/json" \\
            --compressed \\
            --max-time 30 \\
            -d "{\"name\":\"${proj}\",\"namespace\":\"${ns}\",\"repoUrl\":\"\${REPO_URL}\"}")

          echo "HTTP Status: \${HTTP_STATUS}"
          cat /tmp/reg_resp.json && echo ""

          if [ "\${HTTP_STATUS}" = "000" ]; then
            echo "::error::등록 서버에 연결할 수 없습니다 — REGISTER_URL 확인: \${REGISTER_URL}"
            exit 1
          elif [ "\${HTTP_STATUS}" = "401" ]; then
            echo "::error::인증 실패 — GitHub Secret REGISTER_SECRET을 확인하세요"
            exit 1
          elif [ "\${HTTP_STATUS}" = "400" ]; then
            echo "::error::요청 오류 — $(python3 -c "import json;print(json.load(open('/tmp/reg_resp.json')).get('error',''))" 2>/dev/null || echo '')"
            exit 1
          elif [ "\${HTTP_STATUS}" = "500" ]; then
            ERROR_MSG=\$(python3 -c "import json;print(json.load(open('/tmp/reg_resp.json')).get('error','서버 내부 오류'))" 2>/dev/null || echo "서버 내부 오류")
            echo "::error::등록 서버 오류: \${ERROR_MSG}"
            exit 1
          elif [ "\${HTTP_STATUS}" != "200" ]; then
            echo "::warning::등록 서비스 응답 HTTP \${HTTP_STATUS} — Argo CD Git Polling(3분)으로 폴백"
          else
            APP_STATUS=\$(python3 -c "import json;print(json.load(open('/tmp/reg_resp.json')).get('status',''))" 2>/dev/null || echo "")
            SYNC_STATUS=\$(python3 -c "import json;print(json.load(open('/tmp/reg_resp.json')).get('sync',''))" 2>/dev/null || echo "")
            echo "✓ Application: \${APP_STATUS} | Sync: \${SYNC_STATUS}"
            echo "Argo CD selfHeal=true — 클러스터 자동 반영 중"
          fi`
}

// 서비스 타입별 기본 이미지 추출
function getImageForService(svc) {
  if (svc.image) return svc.image
  const t = SERVICE_TEMPLATES[svc.type] || {}
  if (t.isDB) {
    if (svc.type === 'mysql') return 'mysql:8.0'
    if (svc.type === 'redis') return 'redis:7-alpine'
    if (svc.type === 'mongodb') return 'mongo:7.0'
  }
  return `${svc.type}:latest`
}

// 서비스 타입별 실행 가능한 Dockerfile 내용 반환
// DB/공식 이미지는 FROM만으로 충분, 앱 서비스는 최소 실행 코드 포함
function getDockerfileContent(svc) {
  const baseImage = getImageForService(svc)
  const t = SERVICE_TEMPLATES[svc.type] || {}

  // DB 계열 — 공식 이미지가 자체 서버 프로세스 실행
  if (t.isDB) return `FROM ${baseImage}`

  switch (svc.type) {
    case 'spring-boot':
      // 실제 JAR가 없으면 컨테이너가 즉시 종료 → 최소 대기 프로세스 삽입
      return `FROM ${baseImage}
WORKDIR /app
# 실제 빌드 산출물(app.jar)이 있으면 아래 주석을 해제하세요
# COPY build/libs/*.jar app.jar
# ENTRYPOINT ["java","-jar","app.jar"]
RUN apk add --no-cache curl
EXPOSE ${svc.port || t.port || 8080}
CMD ["sh","-c","while true; do echo ok; sleep 30; done"]`

    case 'node-backend':
      return `FROM ${baseImage}
WORKDIR /app
RUN echo '{"name":"node-svc","version":"1.0.0"}' > package.json && \\
    echo 'const http=require("http");http.createServer((_,r)=>{r.writeHead(200);r.end("ok")}).listen(${svc.port || t.port || 3000},()=>console.log("running"))' > index.js
EXPOSE ${svc.port || t.port || 3000}
CMD ["node","index.js"]`

    case 'python-flask': {
      const port = svc.port || t.port || 5000
      return `FROM ${baseImage}
WORKDIR /app
RUN pip install --no-cache-dir flask
RUN printf '%s\\n' \\
    'from flask import Flask' \\
    'app = Flask(__name__)' \\
    '' \\
    '@app.route("/")' \\
    'def healthz():' \\
    '    return "ok"' \\
    '' \\
    'if __name__ == "__main__":' \\
    '    app.run(host="0.0.0.0", port=${port})' \\
    > main.py
EXPOSE ${port}
CMD ["python","main.py"]`
    }

    case 'react-nginx':
      return `FROM ${baseImage}
RUN echo '<html><body><h1>${svc.name}</h1></body></html>' > /usr/share/nginx/html/index.html
EXPOSE ${svc.port || t.port || 80}`

    default:
      return `FROM ${baseImage}`
  }
}

// Argo CD Application 리소스 생성 (자동 동기화 설정 추가)
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
    automated:         # 자동 동기화 활성화
      prune: true      # Git에서 삭제된 리소스를 K8s에서도 삭제
      selfHeal: true   # K8s 리소스가 수동으로 수정되면 Git 상태로 복구
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

// 기존 호환용 래퍼
export function genArgoCDApp(cfg = {}) {
  const { proj = 'my-app', repo = 'https://github.com/ORG/REPO', ns = 'default' } = cfg
  return genArgoApplication(proj, repo, 'HEAD', 'k8s/overlays/production', ns)
}

export function buildManifestYAML(services, ns) {
  const chunks = []
  services.forEach(svc => {
    const d = genDeployment(svc, ns)
    const sv = genService(svc, ns)
    const cm = genConfigMap(svc, ns)
    const sec = genSecret(svc, ns)
    const hpa = genHPA(svc, ns)
    chunks.push(`# ${'─'.repeat(4)} ${svc.name.toUpperCase()} ${'─'.repeat(Math.max(0, 38 - svc.name.length))}`)
    chunks.push(d, sv, cm)
    if (sec) chunks.push(sec)
    if (hpa) chunks.push(hpa)
  })
  return chunks.join('\n---\n')
}

// 서비스 base 디렉토리용 kustomization.yaml 생성
export function genBaseKustomization(svc) {
  return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - manifest.yaml`
}

// production overlay용 kustomization.yaml 생성
export function genOverlayKustomization(services, ns) {
  const imageNameOf = name => name.replace(/-svc$/, '-service-v2')
  return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ${ns}
resources:
${services.map(s => `  - ../../base/${s.name}`).join('\n')}
  - networkpolicy.yaml
images:
${services.map(s => `  - name: ${s.name}
    newName: ${imageNameOf(s.name)}`).join('\n')}`
}

