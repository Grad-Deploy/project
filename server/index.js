// ════════════════════════════════════════════════════════
//  Grad-Deploy Registration Service (Extended)
//
//  엔드포인트:
//    POST /register             - AppProject + Application 자동 생성 (기존)
//    GET  /status/:appName      - Application 상태 조회 (기존)
//    GET  /health               - 헬스체크 (확장: kubectl/cluster 상태 포함)
//
//    *    /argocd-api/*         - ArgoCD CORS 우회 Proxy (Vite plugin 에서 이전)
//                                 - X-Argocd-Target 헤더로 동적 라우팅
//                                 - DeployPanel.jsx 의 argoAutoSetup.js 가 호출
//
//    POST /api/bootstrap        - kubectl 로 AppProject + ApplicationSet 적용
//                                 - GitOps 기반 자동 부트스트랩
//                                 - ApplicationSet Git Generator 사용 가능
//
//  실행: npm start  (또는 npm run dev)
//  환경변수:
//    PORT                       - 기본 4000
//    FRONTEND_ORIGIN            - CORS 허용 origin (기본 http://localhost:5173)
//    ARGOCD_SERVER              - /register 용 (선택)
//    ARGOCD_ADMIN_TOKEN         - /register 용 (선택)
//    REGISTER_SECRET            - /register 용 (선택)
// ════════════════════════════════════════════════════════

require('dotenv').config()
const express = require('express')
const https   = require('https')
const http    = require('http')
const { exec } = require('child_process')
const { promisify } = require('util')

const execAsync = promisify(exec)
const app = express()
app.use(express.json({ limit: '5mb' }))

const {
  ARGOCD_SERVER,
  ARGOCD_ADMIN_TOKEN,
  REGISTER_SECRET,
  FRONTEND_ORIGIN = 'http://localhost:5173',
  PORT = '4000',
} = process.env

// ── 기본 CORS 미들웨어 (간단 구현) ───────────────────────
// /register 엔드포인트는 X-Register-Secret 으로 인증되므로 단순 CORS 만 허용
// /argocd-api 와 /api/bootstrap 은 프론트엔드에서 호출되므로 origin 검사
app.use((req, res, next) => {
  const origin = req.headers.origin

  let allowed = false
  if (!origin) {
    // origin 없는 경우 (서버↔서버 또는 curl) 허용
    allowed = true
  } else if (origin === FRONTEND_ORIGIN) {
    allowed = true
  } else if (/^http:\/\/localhost(:\d+)?$/.test(origin)) {
    allowed = true
  } else {
    try {
      const host = new URL(origin).hostname
      if (/\.trycloudflare\.com$/.test(host)) allowed = true
    } catch (_) {}
  }

  if (allowed && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Register-Secret,X-Argocd-Target')
  }

  if (req.method === 'OPTIONS') {
    return res.status(allowed ? 204 : 403).end()
  }
  next()
})

// ── 요청 로깅 (디버깅 용) ───────────────────────────────
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`)
  next()
})

// ════════════════════════════════════════════════════════
//  [기존] Argo CD API 헬퍼 (/register 용)
//  자체 서명 인증서 허용 (minikube / ngrok 환경 대응)
// ════════════════════════════════════════════════════════
function argoRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    if (!ARGOCD_SERVER) { reject(new Error('ARGOCD_SERVER not configured')); return }

    let base = ARGOCD_SERVER.replace(/\/$/, '')
    if (!/^https?:\/\//.test(base)) base = 'https://' + base
    const url     = new URL(apiPath, base)
    const isHttps = url.protocol === 'https:'
    const mod     = isHttps ? https : http
    const reqBody = body ? JSON.stringify(body) : undefined

    const options = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        Authorization:  `Bearer ${ARGOCD_ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
        ...(reqBody ? { 'Content-Length': Buffer.byteLength(reqBody) } : {}),
      },
      rejectUnauthorized: false,
    }

    const req = mod.request(options, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, body: data }) }
      })
    })
    req.on('error', reject)
    if (reqBody) req.write(reqBody)
    req.end()
  })
}

// ── 인증 미들웨어 (/register 전용) ───────────────────────
function auth(req, res, next) {
  if (req.headers['x-register-secret'] !== REGISTER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized: X-Register-Secret mismatch' })
  }
  next()
}

// ════════════════════════════════════════════════════════
//  [기존] POST /register
//  Body: { name, namespace, repoUrl, path? }
//  1. AppProject 생성 (없으면)
//  2. Application 생성 (없으면)
//  3. Sync 트리거
// ════════════════════════════════════════════════════════
app.post('/register', auth, async (req, res) => {
  const { name, namespace, repoUrl, path: appPath = 'k8s/overlays/production' } = req.body

  if (!name || !namespace || !repoUrl) {
    return res.status(400).json({ error: 'name, namespace, repoUrl are required' })
  }

  const appName     = `${name}-app`
  const projectName = `${name}-project`
  const tag         = `[${name}]`

  try {
    // AppProject 확인/생성
    const projCheck = await argoRequest('GET', `/api/v1/projects/${projectName}`)
    if (projCheck.status === 404) {
      const r = await argoRequest('POST', '/api/v1/projects', {
        project: {
          metadata: { name: projectName, namespace: 'argocd' },
          spec: {
            description:  `GitOps project for ${name}`,
            sourceRepos:  [repoUrl],
            destinations: [{ namespace, server: 'https://kubernetes.default.svc' }],
            clusterResourceWhitelist: [{ group: '', kind: 'Namespace' }],
          },
        },
      })
      if (r.status >= 400) throw new Error(`AppProject 생성 실패 (${r.status}): ${JSON.stringify(r.body)}`)
      console.log(`${tag} AppProject created: ${projectName}`)
    } else if (projCheck.status !== 200) {
      throw new Error(`AppProject 조회 실패 (${projCheck.status})`)
    }

    // Application 확인/생성
    let appStatus = 'exists'
    const appCheck = await argoRequest('GET', `/api/v1/applications/${appName}`)
    if (appCheck.status === 404) {
      const r = await argoRequest('POST', '/api/v1/applications', {
        metadata: { name: appName, namespace: 'argocd' },
        spec: {
          project: projectName,
          source:  { repoURL: repoUrl, targetRevision: 'HEAD', path: appPath },
          destination: { server: 'https://kubernetes.default.svc', namespace },
          syncPolicy: {
            automated:   { prune: true, selfHeal: true },
            syncOptions: ['CreateNamespace=true'],
          },
        },
      })
      if (r.status >= 400) throw new Error(`Application 생성 실패 (${r.status}): ${JSON.stringify(r.body)}`)
      appStatus = 'created'
      console.log(`${tag} Application created: ${appName}`)
      await new Promise(r => setTimeout(r, 1000))
    } else if (appCheck.status !== 200) {
      throw new Error(`Application 조회 실패 (${appCheck.status})`)
    }

    // Sync
    const syncResult = await argoRequest('POST', `/api/v1/applications/${appName}/sync`, {
      prune:    true,
      strategy: { hook: { force: false } },
    })
    const syncOk = syncResult.status < 400
    if (syncOk) console.log(`${tag} Sync triggered: ${appName}`)
    else console.warn(`${tag} Sync warning (${syncResult.status}):`, syncResult.body)

    res.json({
      status:  appStatus,
      app:     appName,
      project: projectName,
      sync:    syncOk ? 'triggered' : `warning:${syncResult.status}`,
    })
  } catch (err) {
    console.error(`${tag} Error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

// ════════════════════════════════════════════════════════
//  [기존] GET /status/:appName
// ════════════════════════════════════════════════════════
app.get('/status/:appName', auth, async (req, res) => {
  try {
    const result = await argoRequest('GET', `/api/v1/applications/${req.params.appName}`)
    if (result.status === 404) return res.status(404).json({ error: 'Application not found' })
    if (result.status !== 200) return res.status(result.status).json({ error: 'Argo CD error' })
    const s = result.body?.status || {}
    res.json({
      app:    req.params.appName,
      sync:   s.sync?.status          || 'Unknown',
      health: s.health?.status        || 'Unknown',
      phase:  s.operationState?.phase || '',
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ════════════════════════════════════════════════════════
//  [확장] GET /health
//  - 백엔드 + kubectl + 클러스터 상태까지 확인
// ════════════════════════════════════════════════════════
app.get('/health', async (req, res) => {
  const health = {
    ok: true,
    backend: 'grad-deploy-registration',
    argocd: ARGOCD_SERVER || 'not configured (using proxy mode)',
    kubectl: null,
    clusterConnected: false,
  }

  // kubectl 설치 여부
  try {
    const { stdout } = await execAsync('kubectl version --client=true -o json', { timeout: 5000 })
    health.kubectl = JSON.parse(stdout).clientVersion?.gitVersion || 'installed'
  } catch (e) {
    health.kubectl = 'not installed'
    health.kubectlError = e.message
  }

  // 클러스터 접근 가능 여부
  if (health.kubectl && health.kubectl !== 'not installed') {
    try {
      await execAsync('kubectl get nodes --request-timeout=5s', { timeout: 8000 })
      health.clusterConnected = true
    } catch (e) {
      health.clusterConnected = false
    }
  }

  res.json(health)
})

// ════════════════════════════════════════════════════════
//  [신규] ArgoCD CORS 우회 Proxy
//
//  Vite plugin (vite.config.js 의 argocdProxyPlugin) 에서 이전.
//  이제 백엔드 server/index.js 에서 처리하므로
//  production 빌드 후에도 동일하게 동작.
//
//  사용법:
//    클라이언트가 보내는 요청:
//      POST /argocd-api/api/v1/session
//      Header: X-Argocd-Target: https://xxx.trycloudflare.com
//    서버 동작:
//      → 헤더의 URL 로 요청 forward
//      → 응답을 그대로 클라이언트에 반환
// ════════════════════════════════════════════════════════
app.use('/argocd-api', async (req, res) => {
  const targetUrl = req.headers['x-argocd-target']
  if (!targetUrl) {
    return res.status(400).json({
      error: 'X-Argocd-Target 헤더가 누락되었습니다',
      hint: 'argoAutoSetup.js 에서 ArgoCD URL 을 헤더에 담아 보내야 합니다',
    })
  }

  // /argocd-api/api/v1/session → /api/v1/session
  const targetPath = req.url
  const fullTargetUrl = `${targetUrl.replace(/\/+$/, '')}${targetPath}`

  try {
    // forward 할 헤더 정리
    const forwardHeaders = { ...req.headers }
    delete forwardHeaders['x-argocd-target']
    delete forwardHeaders.host
    delete forwardHeaders['content-length']
    delete forwardHeaders['accept-encoding']   // gzip mismatch 방지
    delete forwardHeaders.origin
    delete forwardHeaders.referer
    delete forwardHeaders.connection

    const body = ['GET', 'HEAD'].includes(req.method)
      ? undefined
      : JSON.stringify(req.body)

    if (body) {
      forwardHeaders['content-type'] = 'application/json'
    }

    const upstream = await fetch(fullTargetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body,
      redirect: 'manual',
    })

    // 응답 전달
    res.status(upstream.status)
    upstream.headers.forEach((v, k) => {
      const lower = k.toLowerCase()
      // 압축/길이/hop-by-hop 헤더 제외 + CORS 헤더는 백엔드가 위에서 이미 설정함
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection',
            'access-control-allow-origin', 'access-control-allow-methods',
            'access-control-allow-headers'].includes(lower)) {
        res.setHeader(k, v)
      }
    })
    const buf = Buffer.from(await upstream.arrayBuffer())
    res.end(buf)
  } catch (e) {
    res.status(502).json({
      error: `ArgoCD proxy 실패: ${e.message}`,
      target: fullTargetUrl,
      hint: 'ArgoCD URL 이 활성 상태인지, cloudflared tunnel 이 떠 있는지 확인하세요',
    })
  }
})

// ════════════════════════════════════════════════════════
//  [신규] POST /api/bootstrap
//
//  AppProject + ApplicationSet 를 kubectl 로 클러스터에 적용.
//  /register 와의 차이:
//    /register      → ArgoCD REST API 로 Application 한 개 생성 (간단)
//    /api/bootstrap → kubectl 로 AppProject + ApplicationSet 적용
//                     ApplicationSet 의 Git Generator 가 services/* 폴더를 감시
//                     서비스 추가 시 자동으로 Application 생성됨
//
//  Body: { proj, repoUrl, ghUser, pat, namespace? }
//
//  보안:
//    - 입력은 화이트리스트 검증 (영숫자/하이픈만 허용)
//    - 셸 명령에 사용자 입력을 직접 보간하지 않고 env 로 전달
//    - PAT 은 응답 메시지에서 마스킹
// ════════════════════════════════════════════════════════
app.post('/api/bootstrap', async (req, res) => {
  const { proj, repoUrl, ghUser, pat, namespace } = req.body

  // 입력 검증 (화이트리스트)
  const safePattern = /^[a-zA-Z0-9_-]+$/
  if (!safePattern.test(proj || '')) {
    return res.status(400).json({ error: '잘못된 proj 형식 (영숫자/하이픈/언더스코어만 허용)' })
  }
  if (!safePattern.test(ghUser || '')) {
    return res.status(400).json({ error: '잘못된 ghUser 형식' })
  }
  if (!/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/.test(repoUrl || '')) {
    return res.status(400).json({ error: '잘못된 repoUrl 형식 (https://github.com/owner/repo)' })
  }
  if (!/^(ghp_|github_pat_)[\w]+$/.test(pat || '')) {
    return res.status(400).json({ error: '잘못된 PAT 형식' })
  }

  const ns = (namespace && safePattern.test(namespace)) ? namespace : 'argocd'
  const rawUrl = repoUrl.replace('github.com', 'raw.githubusercontent.com')

  // 환경변수로 전달 (셸 인젝션 방지)
  const env = {
    ...process.env,
    PROJ: proj,
    REPO_URL: repoUrl,
    RAW_URL: rawUrl,
    GH_USER: ghUser,
    PAT: pat,
    NS: ns,
  }

  // 단계별 실행
  const steps = [
    {
      name: 'Repository Secret 생성',
      cmd: `kubectl create secret generic "\${PROJ}-git-repo-creds" \
        -n "\${NS}" \
        --from-literal=type="git" \
        --from-literal=url="\${REPO_URL}" \
        --from-literal=username="\${GH_USER}" \
        --from-literal=password="\${PAT}" \
        --dry-run=client -o yaml | kubectl apply -f -`,
    },
    {
      name: 'Repository Secret 레이블 지정',
      cmd: `kubectl label secret "\${PROJ}-git-repo-creds" \
        -n "\${NS}" \
        argocd.argoproj.io/secret-type=repository --overwrite`,
    },
    {
      name: 'AppProject 적용',
      cmd: `curl -fsSL -H "Authorization: token \${PAT}" \
        "\${RAW_URL}/main/k8s/projects/\${PROJ}/argo-project.yaml" \
        | kubectl apply -n "\${NS}" -f -`,
    },
    {
      name: '부모 Application 적용',
      cmd: `curl -fsSL -H "Authorization: token \${PAT}" \
        "\${RAW_URL}/main/k8s/projects/\${PROJ}/argo-parent-app.yaml" \
        | kubectl apply -n "\${NS}" -f -`,
    },
    {
      name: 'ApplicationSet 적용',
      cmd: `curl -fsSL -H "Authorization: token \${PAT}" \
        "\${RAW_URL}/main/k8s/projects/\${PROJ}/argo-appset.yaml" \
        | kubectl apply -n "\${NS}" -f -`,
    },
  ]

  // PAT 마스킹 함수
  const sanitize = s => (s || '').replace(new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***PAT***')

  const results = []
  for (const step of steps) {
    try {
      const { stdout, stderr } = await execAsync(step.cmd, {
        env,
        shell: '/bin/bash',
        timeout: 30000,
      })
      results.push({
        name: step.name,
        ok: true,
        output: sanitize((stdout.trim() || stderr.trim()).slice(0, 500)),
      })
    } catch (e) {
      results.push({
        name: step.name,
        ok: false,
        error: sanitize(e.message),
        stderr: sanitize(e.stderr || ''),
      })
      return res.status(500).json({ ok: false, steps: results })
    }
  }

  res.json({ ok: true, steps: results })
})

// ════════════════════════════════════════════════════════
//  서버 시작
// ════════════════════════════════════════════════════════
app.listen(Number(PORT), '0.0.0.0', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`✓ Grad-Deploy Registration Service`)
  console.log(`  Listening on http://0.0.0.0:${PORT}`)
  console.log(`  Frontend origin: ${FRONTEND_ORIGIN}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  Endpoints:')
  console.log('    GET  /health')
  console.log('    POST /register        (X-Register-Secret 필요)')
  console.log('    GET  /status/:appName (X-Register-Secret 필요)')
  console.log('    *    /argocd-api/*    (X-Argocd-Target 헤더 필요)')
  console.log('    POST /api/bootstrap   (kubectl 사용)')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  if (ARGOCD_SERVER) console.log(`  Argo CD target (for /register): ${ARGOCD_SERVER}`)
  else console.log(`  ⚠ /register 사용 시 ARGOCD_SERVER 환경변수 필요`)
})
