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
const fs      = require('fs')
const path    = require('path')
const { exec, spawn } = require('child_process')
const { promisify } = require('util')

const execAsync = promisify(exec)

const execWithStdin = (cmd, stdinData, options = {}) => {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
    if (stdinData !== undefined && stdinData !== null) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
  });
};
const app = express()
app.use(express.json({ limit: '5mb' }))
function toK8sName(value, fallback = 'my-app') {
  const normalized = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .replace(/[-.]{2,}/g, '-')
  return normalized || fallback
}

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
    SAFE_PROJ: toK8sName(proj),
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
      cmd: `kubectl create secret generic "\${SAFE_PROJ}-git-repo-creds" \
        -n "\${NS}" \
        --from-literal=type="git" \
        --from-literal=url="\${REPO_URL}" \
        --from-literal=username="\${GH_USER}" \
        --from-literal=password="\${PAT}" \
        --dry-run=client -o yaml | kubectl apply --validate=false -f -`,
    },
    {
      name: 'Repository Secret 레이블 지정',
      cmd: `kubectl label secret "\${SAFE_PROJ}-git-repo-creds" \
        -n "\${NS}" \
        argocd.argoproj.io/secret-type=repository --overwrite`,
    },
    {
      name: 'AppProject 적용',
      cmd: `curl -fsSL -H "Authorization: token \${PAT}" \
        "\${RAW_URL}/main/k8s/projects/\${PROJ}/argo-project.yaml" \
        | kubectl apply --validate=false -n "\${NS}" -f -`,
    },
    {
      name: '부모 Application 적용',
      cmd: `curl -fsSL -H "Authorization: token \${PAT}" \
        "\${RAW_URL}/main/k8s/projects/\${PROJ}/argo-parent-app.yaml" \
        | kubectl apply --validate=false -n "\${NS}" -f -`,
    },
    {
      name: 'ApplicationSet 적용',
      cmd: `curl -fsSL -H "Authorization: token \${PAT}" \
        "\${RAW_URL}/main/k8s/projects/\${PROJ}/argo-appset.yaml" \
        | kubectl apply --validate=false -n "\${NS}" -f -`,
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
//  [Task 2] GET /api/demo/github/status
//  최신 GitHub Actions 워크플로우 실행 상태 조회
// ════════════════════════════════════════════════════════
app.get('/api/demo/github/status', async (req, res) => {
  try {
    const { stdout } = await execAsync('gh run list --limit 5 --json name,status,conclusion,url,createdAt', { timeout: 8000 })
    res.json(JSON.parse(stdout))
  } catch (err) {
    console.warn('[Demo API] gh CLI 실행 실패, 모크 데이터 반환:', err.message)
    res.json([
      {
        name: "Grad-Deploy CI/CD Pipeline",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/Grad-Deploy/project/actions",
        createdAt: new Date().toISOString()
      }
    ])
  }
})

// ════════════════════════════════════════════════════════
//  [Task 2] GET /api/demo/argocd/applications
//  프로젝트 내 모든 Argo CD Application의 Sync/Health 상태 요약 조회
// ════════════════════════════════════════════════════════
app.get('/api/demo/argocd/applications', async (req, res) => {
  const proj = req.query.project || 'grad-deploy'
  try {
    const { stdout } = await execAsync(`kubectl get applications -n argocd -l grad-deploy/project=${proj} -o json`, { timeout: 8000 })
    const data = JSON.parse(stdout)
    const apps = (data.items || []).map(item => ({
      name: item.metadata.name,
      sync: item.status?.sync?.status || 'Unknown',
      health: item.status?.health?.status || 'Unknown',
    }))
    res.json({ ok: true, project: proj, applications: apps })
  } catch (err) {
    console.warn('[Demo API] kubectl get applications 실패:', err.message)
    res.json({
      ok: false,
      error: err.message,
      applications: [
        { name: `${proj}-frontend`, sync: "Synced", health: "Healthy" },
        { name: `${proj}-backend`, sync: "Synced", health: "Healthy" },
        { name: `${proj}-postgresql`, sync: "Synced", health: "Healthy" }
      ]
    })
  }
})

// ════════════════════════════════════════════════════════
//  [Task 2] GET /api/demo/pods/:namespace
//  특정 네임스페이스 내 모든 Pod의 실시간 세부 진단 데이터 조회
// ════════════════════════════════════════════════════════
app.get('/api/demo/pods/:namespace', async (req, res) => {
  const ns = req.params.namespace
  try {
    const { stdout } = await execAsync(`kubectl get pods -n ${ns} -o json`, { timeout: 8000 })
    const data = JSON.parse(stdout)
    const pods = (data.items || []).map(item => {
      const containerStatuses = item.status?.containerStatuses || []
      const readyCount = containerStatuses.filter(c => c.ready).length
      const totalCount = containerStatuses.length
      const readyStr = `${readyCount}/${totalCount}`
      const restarts = containerStatuses.reduce((sum, c) => sum + c.restartCount, 0)

      let reason = item.status?.phase || 'Unknown'
      let message = ''

      for (const c of containerStatuses) {
        if (c.state?.waiting) {
          reason = c.state.waiting.reason || reason
          message = c.state.waiting.message || message
        } else if (c.state?.terminated) {
          reason = c.state.terminated.reason || reason
          message = c.state.terminated.message || message
        }
      }

      const creationTime = new Date(item.metadata.creationTimestamp)
      const diffMs = Date.now() - creationTime.getTime()
      const diffMins = Math.floor(diffMs / 60000)
      const ageStr = diffMins > 60 ? `${Math.floor(diffMins / 60)}h` : `${diffMins}m`

      return {
        podName: item.metadata.name,
        status: item.status?.phase || 'Unknown',
        reason,
        ready: readyStr,
        restarts,
        message,
        age: ageStr,
      }
    })
    res.json(pods)
  } catch (err) {
    console.error('[Demo API] kubectl get pods 실패:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ════════════════════════════════════════════════════════
//  [Task 2] GET /api/demo/ingress/:namespace
//  네임스페이스 내의 Ingress 정보를 조회하여 외부 접속용 URL 리스트를 조립해 반환
// ════════════════════════════════════════════════════════
app.get('/api/demo/ingress/:namespace', async (req, res) => {
  const ns = req.params.namespace
  try {
    // tmux cf-ingress 창에서 cloudflared 터널 URL 추출 시도
    let ingressHost = 'localhost'
    try {
      const { stdout: tmuxOut } = await execAsync('tmux capture-pane -t graddeploy:cf-ingress -p', { timeout: 2500 })
      const match = tmuxOut.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (match) {
        ingressHost = match[0].replace(/^https?:\/\//, '')
      }
    } catch (_) {
      // tmux가 없거나 cf-ingress 터널이 꺼져있을 땐 기본 localhost로 폴백
    }

    const { stdout } = await execAsync(`kubectl get ingress -n ${ns} -o json`, { timeout: 8000 })
    const data = JSON.parse(stdout)
    const urls = []

    for (const item of data.items || []) {
      const rules = item.spec?.rules || []
      for (const rule of rules) {
        let host = rule.host || 'localhost'
        if (host === 'localhost' || host === '*') {
          host = ingressHost
        }
        const paths = rule.http?.paths || []
        for (const p of paths) {
          const path = p.path || '/'
          const protocol = host.includes('localhost') ? 'http' : 'https'
          const name = path === '/' ? 'Frontend URL' : `API URL (${path})`
          urls.push({
            name,
            url: `${protocol}://${host}${path}`,
          })
        }
      }
    }

    res.json({ ok: true, urls })
  } catch (err) {
    console.error('[Demo API] kubectl get ingress 실패:', err.message)
    res.json({
      ok: false,
      error: err.message,
      urls: [
        { name: "Frontend Address (Local Port-forward)", url: "http://localhost:5173" },
        { name: "API Address (Local Port-forward)", url: "http://localhost:4000" }
      ]
    })
  }
})

// ════════════════════════════════════════════════════════
//  [신규] POST /api/apply-secrets
//  Kubernetes Secret 자동 생성 및 관련 Pod 재시작 (delete)
// ════════════════════════════════════════════════════════
app.post('/api/apply-secrets', async (req, res) => {
  const { namespace, secrets, ghcr } = req.body

  const safePattern = /^[a-zA-Z0-9_-]+$/
  const ns = (namespace && safePattern.test(namespace)) ? namespace : 'default'

  // secrets 는 비어 있어도 무방(예: GHCR imagePullSecret 만 생성하는 경우).
  const secretList = Array.isArray(secrets) ? secrets : []

  const results = []
  try {
    // 1. 네임스페이스 생성/확인
    await execAsync(`kubectl create namespace ${ns} --dry-run=client -o yaml | kubectl apply -f -`, { timeout: 10000 })

    // 1.5 GHCR imagePullSecret(ghcr-secret) 자동 생성 ─────────────────────
    //   deployment.yaml 의 `imagePullSecrets: - name: ghcr-secret` 가 참조하는 Secret.
    //   GITHUB_TOKEN 으로 빌드된 GHCR 패키지는 기본 private 이므로, 이 Secret 이
    //   없으면 Pod 가 이미지를 Pull 하지 못해 ImagePullBackOff / Pod 미생성이 된다.
    //   (수동 부트스트랩 명령어에는 있었으나 자동 배포 경로에는 누락되어 있던 단계)
    if (ghcr && ghcr.username && ghcr.pat) {
      const ghUserOk = /^[A-Za-z0-9-]+$/.test(ghcr.username)
      const ghPatOk  = /^(ghp_|github_pat_)[\w]+$/.test(ghcr.pat)
      if (!ghUserOk || !ghPatOk) {
        results.push({ name: 'ghcr-secret', ok: false, error: 'GitHub 사용자명 또는 PAT 형식이 올바르지 않습니다' })
      } else {
        try {
          // 셸 인젝션 방지: 값은 env 로 전달하고 명령에는 변수만 보간
          await execAsync(
            `kubectl create secret docker-registry ghcr-secret ` +
            `--docker-server=ghcr.io ` +
            `--docker-username="$GHCR_USER" ` +
            `--docker-password="$GHCR_PAT" ` +
            `--docker-email=grad-deploy@example.com ` +
            `-n ${ns} --dry-run=client -o yaml | kubectl apply -f -`,
            {
              env: { ...process.env, GHCR_USER: ghcr.username, GHCR_PAT: ghcr.pat },
              shell: '/bin/bash',
              timeout: 10000,
            }
          )
          results.push({ name: 'ghcr-secret', ok: true })
        } catch (e) {
          const masked = String(e.message || '').split(ghcr.pat).join('***PAT***')
          results.push({ name: 'ghcr-secret', ok: false, error: masked })
        }
      }
    }

    for (const sec of secretList) {
      if (!sec.name || !safePattern.test(sec.name)) {
        throw new Error(`잘못된 secret 이름 형식: ${sec.name}`)
      }

      const keys = Object.keys(sec.data || {})
      if (keys.length === 0) continue

      let stringDataYaml = ''
      for (const k of keys) {
        if (!/^[a-zA-Z0-9_.-]+$/.test(k)) {
          throw new Error(`잘못된 secret 키 형식: ${k}`)
        }
        stringDataYaml += `  ${k}: |-\n${String(sec.data[k]).split('\n').map(line => `    ${line}`).join('\n')}\n`
      }

      const secretYaml = `apiVersion: v1
kind: Secret
metadata:
  name: ${sec.name}
  namespace: ${ns}
type: Opaque
stringData:
${stringDataYaml}`

      // stdin으로 안전하게 apply 실행 (셸 인젝션 원천 차단)
      await execWithStdin(`kubectl apply -f -`, secretYaml, { timeout: 10000 })

      // 2. 관련된 Pod 재시작 (새 Secret 즉시 인식 유도)
      if (sec.svcName && safePattern.test(sec.svcName)) {
        try {
          await execAsync(`kubectl delete pods -n ${ns} -l app=${sec.svcName} --ignore-not-found=true`, { timeout: 10000 })
        } catch (e) {
          console.warn(`[apply-secrets] Pod delete failed for ${sec.svcName}:`, e.message)
        }
      }

      results.push({ name: sec.name, ok: true })
    }

    res.json({ ok: true, secrets: results })
  } catch (err) {
    console.error('[apply-secrets] 실패:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ════════════════════════════════════════════════════════
//  [신규] POST /api/port-forward
//  Pod 가 Ready 될 때까지(= GitHub Actions 빌드 완료 + ArgoCD sync 후) 기다렸다가
//  자동으로 포트포워딩을 시작하고, Pod 가 롤오버되면 자동 재연결하는 supervisor.
//
//  기존 방식의 문제: 배포 직후엔 CI 가 이미지를 빌드하기 전이라 Pod 가 없어
//  포워딩이 곧바로 실패했다. 이제는 "감시(watch)"만 시작하고 즉시 응답한 뒤,
//  백그라운드에서 Pod 가 Ready 되는 순간 포워딩을 띄운다.
// ════════════════════════════════════════════════════════
global.activePortForwards = global.activePortForwards || {}
global.pfSupervisors = global.pfSupervisors || {}

// 로컬 포트 lp 점유 프로세스 + 이 서비스로 향하는 잔여 포워더를 정리한다.
async function freeLocalPort(lp, cp, serviceName) {
  const targetPort = lp === 8081 ? 18081 : lp;
  if (process.platform !== 'win32') {
    const cmd =
      `fuser -k ${targetPort}/tcp 2>/dev/null; ` +
      `lsof -ti tcp:${targetPort} 2>/dev/null | xargs -r kill -9 2>/dev/null; ` +
      `pkill -f "port-forward.* ${targetPort}:${cp}" 2>/dev/null; ` +
      `pkill -f "port-forward svc/${serviceName} " 2>/dev/null; true`
    try { await execAsync(cmd, { shell: '/bin/bash', timeout: 8000 }) } catch (_) {}
  } else {
    const cmd = `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${targetPort} ^| findstr LISTENING') do taskkill /F /PID %a`
    try { await execAsync(cmd, { shell: true, timeout: 8000 }) } catch (_) {}
  }
}

// Ready Pod 가 생길 때까지(=CI 빌드 완료 후) 기다렸다가 포워딩하고, 끊기면 재연결한다.
async function runPortForwardSupervisor(serviceName, ns, lp, cp) {
  const sup = global.pfSupervisors[lp]
  if (!sup) return
  const firstReadyDeadline = Date.now() + 30 * 60 * 1000  // 첫 Ready 대기 최대 30분
  let everForwarded = false
  const targetPort = lp === 8081 ? 18081 : lp;

  while (sup && !sup.stop) {
    // 1) Ready Pod 대기 — 없으면(아직 CI 빌드 중) 재시도
    let ready = false
    try {
      await execAsync(
        `kubectl wait --for=condition=ready pod -l app=${serviceName} -n ${ns} --timeout=60s`,
        { timeout: 65000 }
      )
      ready = true
    } catch (_) { ready = false }

    if (sup.stop) break
    if (!ready) {
      if (!everForwarded && Date.now() > firstReadyDeadline) {
        sup.status = 'timeout'
        console.warn(`[pf-supervisor] ${serviceName}: 30분 내 Ready Pod 없음 — 감시 종료`)
        break
      }
      sup.status = 'waiting'   // 빌드/배포 진행 중 (Pod 아직 준비 안됨)
      await new Promise(r => setTimeout(r, 5000))
      continue
    }

    // 2) 포트 비우고 포워딩 (자식 프로세스가 끝날 때까지 대기 = Pod 살아있는 동안 유지)
    await freeLocalPort(lp, cp, serviceName)
    sup.status = 'forwarding'
    everForwarded = true
    console.log(`[pf-supervisor] ${serviceName}: port-forward ${targetPort}:${cp} 시작`)
    await new Promise((resolve) => {
      const child = spawn('kubectl',
        ['port-forward', `svc/${serviceName}`, '-n', ns, `${targetPort}:${cp}`, '--address=127.0.0.1'],
        { stdio: 'ignore' })
      sup.child = child
      child.on('exit', () => { sup.child = null; resolve() })
      child.on('error', () => { sup.child = null; resolve() })
    })

    if (sup.stop) break
    // 끊김(Pod 롤오버·네트워크) → 잠시 후 다시 Ready 확인하고 재연결
    sup.status = 'reconnecting'
    await new Promise(r => setTimeout(r, 3000))
  }
  await freeLocalPort(lp, cp, serviceName).catch(() => {})
  console.log(`[pf-supervisor] ${serviceName}: 감시 종료`)
}

// 이전 포트포워딩 설정 자동 복구
function autoStartLastPortForward() {
  const configPath = path.join(__dirname, 'last-port-forward.json');
  if (fs.existsSync(configPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (data && data.serviceName && data.localPort) {
        const { serviceName, namespace, localPort, containerPort } = data;
        const lp = parseInt(localPort);
        const cp = parseInt(containerPort);
        const ns = namespace || 'default';
        
        if (!global.pfSupervisors[lp] || global.pfSupervisors[lp].stop) {
          console.log(`[port-forward startup] 복구 구동: ${serviceName} (${lp}:${cp})`);
          const sup = { stop: false, child: null, status: 'waiting', serviceName, ns, lp, cp };
          global.pfSupervisors[lp] = sup;
          runPortForwardSupervisor(serviceName, ns, lp, cp).catch(e =>
            console.error('[pf-supervisor startup] 오류:', e && e.message));
        }
      }
    } catch (err) {
      console.warn(`[port-forward startup] 이전 설정 파일 로드 오류:`, err.message);
    }
  }
}

app.post('/api/port-forward', async (req, res) => {
  const { serviceName, namespace, localPort, containerPort } = req.body

  const safePattern = /^[a-zA-Z0-9_-]+$/
  if (!safePattern.test(serviceName || '')) {
    return res.status(400).json({ error: '잘못된 serviceName 형식' })
  }
  const ns = (namespace && safePattern.test(namespace)) ? namespace : 'default'
  const lp = parseInt(localPort)
  const cp = parseInt(containerPort)
  if (isNaN(lp) || isNaN(cp)) {
    return res.status(400).json({ error: 'localPort 및 containerPort는 숫자여야 합니다' })
  }

  try {
    // ── 상태 파일 영속성 기록
    const configPath = path.join(__dirname, 'last-port-forward.json');
    fs.writeFileSync(configPath, JSON.stringify({ serviceName, namespace: ns, localPort: lp, containerPort: cp }, null, 2));

    // 기존 supervisor 중지 + 기존 포워더/포트 정리
    const prev = global.pfSupervisors[lp]
    if (prev) {
      prev.stop = true
      try { prev.child && prev.child.kill('SIGTERM') } catch (_) {}
    }
    if (global.activePortForwards[lp]) {
      try { global.activePortForwards[lp].kill('SIGTERM') } catch (_) {}
      delete global.activePortForwards[lp]
    }
    await freeLocalPort(lp, cp, serviceName)

    // 새 supervisor 시작 — 즉시 반환하고, Pod 가 Ready 되면 백그라운드에서 자동 포워딩
    const sup = { stop: false, child: null, status: 'waiting', serviceName, ns, lp, cp }
    global.pfSupervisors[lp] = sup
    runPortForwardSupervisor(serviceName, ns, lp, cp).catch(e =>
      console.error('[pf-supervisor] 오류:', e && e.message))

    res.json({
      ok: true,
      watching: true,
      message: `Pod 준비 감시를 시작했습니다. GitHub Actions 빌드가 끝나고 Pod 가 Ready 되면 자동으로 포트포워딩(${lp}:${cp})이 시작됩니다.`,
    })
  } catch (err) {
    console.error('[port-forward] 실패:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ────────────────────────────────────────────────────────
//  GET /api/port-forward/status?localPort=8081
//  현재 포워딩 감시 상태 조회 (프론트가 폴링해 "접속 가능" 안내에 사용)
// ────────────────────────────────────────────────────────
app.get('/api/port-forward/status', (req, res) => {
  const lp = parseInt(req.query.localPort)
  const sup = !isNaN(lp) ? global.pfSupervisors[lp] : null
  if (!sup) return res.json({ active: false, status: 'none' })
  res.json({
    active: !sup.stop,
    status: sup.status,            // waiting | forwarding | reconnecting | timeout
    serviceName: sup.serviceName,
    localPort: sup.lp,
  })
})

// ── 8081 포트 전용 프록시 및 대기 화면 서버 ────────────────
const proxyServer = http.createServer((req, res) => {
  let sup = global.pfSupervisors[8081];
  if (!sup) {
    autoStartLastPortForward();
    sup = global.pfSupervisors[8081];
  }

  if (sup && sup.status === 'forwarding') {
    // 1) 포트포워딩 활성화 상태: 18081 포트(실제 포트포워딩)로 투명 프록시 전달
    const proxyReq = http.request({
      host: '127.0.0.1',
      port: 18081,
      path: req.url,
      method: req.method,
      headers: req.headers
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
      console.error(`[8081-proxy error]`, err.message);
      if (sup) sup.status = 'reconnecting';
      serveLoadingPage(req, res, sup);
    });

    req.pipe(proxyReq, { end: true });
  } else {
    // 2) 준비 중 상태: 고품격 현황판 대기 화면 서빙
    serveLoadingPage(req, res, sup);
  }
});

proxyServer.listen(8081, '0.0.0.0', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('✓ Mini Board Proxy Server Active on http://localhost:8081');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
});

function serveLoadingPage(req, res, sup) {
  const ns = sup ? sup.ns : 'default';
  
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Grad-Deploy — Mini Board 준비 중</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Noto+Sans+KR:wght@300;400;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(22, 30, 49, 0.7);
      --border: rgba(255, 255, 255, 0.08);
      --primary: #3b82f6;
      --primary-glow: rgba(59, 130, 246, 0.25);
      --green: #10b981;
      --yellow: #f59e0b;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
    }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Outfit', 'Noto Sans KR', sans-serif;
      margin: 0;
      padding: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      position: relative;
    }
    body::before {
      content: '';
      position: absolute;
      width: 400px;
      height: 400px;
      background: var(--primary-glow);
      filter: blur(150px);
      border-radius: 50%;
      z-index: 0;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      pointer-events: none;
    }
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 40px;
      width: 90%;
      max-width: 480px;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
      z-index: 1;
      animation: fadeIn 0.8s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    h1 {
      font-size: 26px;
      font-weight: 800;
      margin-top: 0;
      margin-bottom: 8px;
      background: linear-gradient(135deg, #fff 0%, #a5b4fc 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.02em;
    }
    .subtitle {
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 32px;
      font-weight: 300;
      line-height: 1.5;
    }
    .loader {
      width: 54px;
      height: 54px;
      border: 4px solid rgba(59, 130, 246, 0.1);
      border-left-color: var(--primary);
      border-radius: 50%;
      margin: 0 auto 32px;
      animation: spin 1s linear infinite;
      box-shadow: 0 0 20px var(--primary-glow);
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .steps {
      text-align: left;
      display: flex;
      flex-direction: column;
      gap: 14px;
      margin-bottom: 32px;
    }
    .step {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 12px 16px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.04);
      transition: all 0.3s;
    }
    .step.active {
      background: rgba(59, 130, 246, 0.05);
      border-color: rgba(59, 130, 246, 0.2);
    }
    .step-icon {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: bold;
    }
    .step-icon.waiting {
      background: rgba(255, 255, 255, 0.1);
      color: var(--text-muted);
    }
    .step-icon.running {
      background: rgba(245, 158, 11, 0.2);
      color: var(--yellow);
      animation: pulse 1.5s infinite;
    }
    .step-icon.completed {
      background: rgba(16, 185, 129, 0.2);
      color: var(--green);
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.1); opacity: 0.8; }
    }
    .step-details {
      flex: 1;
    }
    .step-title {
      font-size: 13.5px;
      font-weight: 600;
      color: var(--text);
    }
    .step-desc {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .info-footer {
      font-size: 12px;
      color: var(--text-muted);
      border-top: 1px solid var(--border);
      padding-top: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .info-badge {
      padding: 4px 8px;
      border-radius: 6px;
      font-size: 10px;
      font-weight: bold;
      background: rgba(59, 130, 246, 0.15);
      color: var(--primary);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="loader"></div>
    <h1>Mini Board 배포 및 자동 감지 중</h1>
    <div class="subtitle">GitHub Actions 빌드가 끝나고 Pod가 정상 구동되면 자동으로 로컬 포트 포워딩 연결을 시작합니다.</div>
    
    <div class="steps">
      <div class="step" id="step-github">
        <div class="step-icon waiting" id="icon-github">1</div>
        <div class="step-details">
          <div class="step-title">GitHub Actions 빌드 파이프라인 (CI)</div>
          <div class="step-desc" id="desc-github">워크플로우 상태 감지 중...</div>
        </div>
      </div>
      
      <div class="step" id="step-argocd">
        <div class="step-icon waiting" id="icon-argocd">2</div>
        <div class="step-details">
          <div class="step-title">Argo CD GitOps 동기화 (Sync)</div>
          <div class="step-desc" id="desc-argocd">Argo CD 상태 감지 중...</div>
        </div>
      </div>
      
      <div class="step" id="step-pod">
        <div class="step-icon waiting" id="icon-pod">3</div>
        <div class="step-details">
          <div class="step-title">Kubernetes Pod 준비 완료 (Healthy)</div>
          <div class="step-desc" id="desc-pod">Pod 상태 확인 중...</div>
        </div>
      </div>
    </div>
    
    <div class="info-footer">
      <span>배포 접속 주소</span>
      <span class="info-badge">localhost:8081</span>
    </div>
  </div>

  <script>
    async function checkStatus() {
      try {
        // 1. Port Forward Status
        const pfRes = await fetch('http://localhost:4000/api/port-forward/status?localPort=8081');
        const pfData = await pfRes.json();
        
        if (pfData.active && pfData.status === 'forwarding') {
          window.location.reload();
          return;
        }

        // 2. GitHub Actions
        const ghRes = await fetch('http://localhost:4000/api/demo/github/status');
        const ghData = await ghRes.json();
        const latestRun = Array.isArray(ghData) ? ghData[0] : null;
        
        const elGithub = document.getElementById('step-github');
        const iconGithub = document.getElementById('icon-github');
        const descGithub = document.getElementById('desc-github');
        
        if (latestRun) {
          if (latestRun.status === 'completed' && latestRun.conclusion === 'success') {
            elGithub.classList.remove('active');
            iconGithub.className = 'step-icon completed';
            iconGithub.innerHTML = '✓';
            descGithub.innerHTML = '빌드 완료 (CI 성공)';
          } else if (latestRun.status === 'completed') {
            iconGithub.className = 'step-icon waiting';
            iconGithub.innerHTML = '✕';
            descGithub.innerHTML = '빌드 실패 (' + latestRun.conclusion + ')';
          } else {
            elGithub.classList.add('active');
            iconGithub.className = 'step-icon running';
            iconGithub.innerHTML = '⟳';
            descGithub.innerHTML = '이미지 빌드 및 GHCR 푸시 중...';
          }
        } else {
          descGithub.innerHTML = '대기 중...';
        }

        // 3. Argo CD Application
        const argoRes = await fetch('http://localhost:4000/api/demo/argocd/applications');
        const argoData = await argoRes.json();
        
        const elArgo = document.getElementById('step-argocd');
        const iconArgo = document.getElementById('icon-argocd');
        const descArgo = document.getElementById('desc-argocd');
        
        if (argoData.ok && argoData.applications) {
          const app = argoData.applications.find(a => a.name.includes('frontend') || a.name.includes('nginx'));
          if (app) {
            if (app.sync === 'Synced' && app.health === 'Healthy') {
              elArgo.classList.remove('active');
              iconArgo.className = 'step-icon completed';
              iconArgo.innerHTML = '✓';
              descArgo.innerHTML = '동기화 완료 (Synced & Healthy)';
            } else if (app.sync === 'OutOfSync') {
              elArgo.classList.add('active');
              iconArgo.className = 'step-icon running';
              iconArgo.innerHTML = '⟳';
              descArgo.innerHTML = '동기화 대기 중... (OutOfSync)';
            } else {
              elArgo.classList.add('active');
              iconArgo.className = 'step-icon running';
              iconArgo.innerHTML = '⟳';
              descArgo.innerHTML = '상태: ' + app.sync + ' / ' + app.health;
            }
          } else {
            descArgo.innerHTML = '감시 대기 중...';
          }
        } else {
          descArgo.innerHTML = 'Argo CD 연결 확인 중...';
        }

        // 4. Kubernetes Pod
        const podsRes = await fetch('http://localhost:4000/api/demo/pods/${ns}');
        const podsData = await podsRes.json();
        
        const elPod = document.getElementById('step-pod');
        const iconPod = document.getElementById('icon-pod');
        const descPod = document.getElementById('desc-pod');
        
        if (Array.isArray(podsData) && podsData.length > 0) {
          const frontendPod = podsData.find(p => p.podName.includes('frontend') || p.podName.includes('nginx') || p.podName.includes('react-nginx'));
          if (frontendPod) {
            if (frontendPod.status === 'Running' && frontendPod.ready.includes('1/1')) {
              elPod.classList.remove('active');
              iconPod.className = 'step-icon completed';
              iconPod.innerHTML = '✓';
              descPod.innerHTML = 'Pod 실행 중 및 준비 완료 (Running)';
            } else {
              elPod.classList.add('active');
              iconPod.className = 'step-icon running';
              iconPod.innerHTML = '⟳';
              descPod.innerHTML = 'Pod 준비 중 (' + (frontendPod.reason || frontendPod.status) + ')';
            }
          } else {
            descPod.innerHTML = 'Pod 생성 대기 중...';
          }
        } else {
          descPod.innerHTML = 'Pod 기동 대기 중...';
        }

      } catch (e) {
        console.error('상태 조회 실패:', e);
      }
    }

    setInterval(checkStatus, 2000);
    checkStatus();
  </script>
</body>
</html>`);
}

// ════════════════════════════════════════════════════════
//  [신규] POST /api/tunnel-url
//
//  Argo CD API를 통해 클러스터 내 cloudflared-tunnel Pod의 로그를 조회하고,
//  실시간으로 발급된 trycloudflare.com 외부 접속 도메인을 추출합니다.
// ════════════════════════════════════════════════════════
app.post('/api/tunnel-url', async (req, res) => {
  const { proj, namespace, argoServer, argoToken } = req.body

  if (!proj || !argoServer || !argoToken) {
    return res.status(400).json({ error: '필수 매개변수(proj, argoServer, argoToken)가 누락되었습니다' })
  }

  const ns = namespace || 'default'
  const appName = proj
  const argoBase = argoServer.replace(/\/+$/, '')

  try {
    // 1. Argo CD에서 리소스 리스트 조회하여 cloudflared-tunnel Pod 이름 색출
    const resourceUrl = `${argoBase}/api/v1/applications/${appName}/resource`
    console.log(`[tunnel-url] 리소스 조회: ${resourceUrl}`)

    const resourceRes = await fetch(resourceUrl, {
      headers: {
        'Authorization': `Bearer ${argoToken}`,
        'Content-Type': 'application/json'
      }
    })

    if (!resourceRes.ok) {
      const errText = await resourceRes.text()
      return res.status(resourceRes.status).json({ error: `Argo CD 리소스 조회 실패: ${errText}` })
    }

    const resourceData = await resourceRes.json()
    const resources = resourceData.resources || []

    const pod = resources.find(r => r.kind === 'Pod' && r.name && r.name.includes('cloudflared-tunnel'))
    if (!pod) {
      return res.status(404).json({ error: '클러스터에서 cloudflared-tunnel Pod를 찾을 수 없습니다. 배포(Sync) 상태를 확인하십시오.' })
    }

    const podName = pod.name
    console.log(`[tunnel-url] 발견된 Pod: ${podName}`)

    // 2. Argo CD Pod 로그 API 호출하여 tunnel 도메인 파싱
    const logsUrl = `${argoBase}/api/v1/applications/${appName}/resource/logs?namespace=${ns}&name=${podName}&kind=Pod&container=cloudflared`
    console.log(`[tunnel-url] 로그 조회: ${logsUrl}`)

    const logsRes = await fetch(logsUrl, {
      headers: {
        'Authorization': `Bearer ${argoToken}`,
        'Content-Type': 'application/json'
      }
    })

    if (!logsRes.ok) {
      const errText = await logsRes.text()
      return res.status(logsRes.status).json({ error: `Argo CD 로그 조회 실패: ${errText}` })
    }

    const logBody = await logsRes.text()
    
    // trycloudflare.com 주소 정규표현식으로 실시간 매칭
    const domainMatch = logBody.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/)
    if (domainMatch) {
      const tunnelUrl = domainMatch[0]
      console.log(`[tunnel-url] 자동 획득한 주소: ${tunnelUrl}`)
      return res.json({ ok: true, url: tunnelUrl })
    }

    res.status(404).json({ error: '외부 터널 도메인을 로그에서 아직 찾지 못했습니다. 터널 기동 중일 수 있으니 2초 후 재시도하십시오.' })
  } catch (err) {
    console.error('[tunnel-url] 실패:', err.message)
    res.status(500).json({ error: err.message })
  }
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
  
  // ── [신규] 이전 포트포워딩 설정 자동 복원 구동
  autoStartLastPortForward();
})
