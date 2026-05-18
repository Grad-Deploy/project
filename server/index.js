require('dotenv').config()
const express = require('express')
const https   = require('https')
const http    = require('http')

const app = express()
app.use(express.json())

const {
  ARGOCD_SERVER,
  ARGOCD_ADMIN_TOKEN,
  REGISTER_SECRET,
  PORT = '3000',
} = process.env

// ── Argo CD API 헬퍼 ─────────────────────────────────────
// 자체 서명 인증서 허용 (minikube / ngrok 환경 대응)

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

// ── 인증 미들웨어 ────────────────────────────────────────

function auth(req, res, next) {
  if (req.headers['x-register-secret'] !== REGISTER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized: X-Register-Secret mismatch' })
  }
  next()
}

// ── POST /register ───────────────────────────────────────
// Body: { name, namespace, repoUrl, path? }
// 1. AppProject 생성 (없으면)
// 2. Application 생성 (없으면)
// 3. Sync 트리거

app.post('/register', auth, async (req, res) => {
  const { name, namespace, repoUrl, path: appPath = 'k8s/overlays/production' } = req.body

  if (!name || !namespace || !repoUrl) {
    return res.status(400).json({ error: 'name, namespace, repoUrl are required' })
  }

  const appName     = `${name}-app`
  const projectName = `${name}-project`
  const tag         = `[${name}]`

  try {
    // ── AppProject ────────────────────────────────────────
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

    // ── Application ───────────────────────────────────────
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
      await new Promise(r => setTimeout(r, 1000)) // 생성 후 Argo CD 반영 대기
    } else if (appCheck.status !== 200) {
      throw new Error(`Application 조회 실패 (${appCheck.status})`)
    }

    // ── Sync 트리거 ───────────────────────────────────────
    const syncResult = await argoRequest('POST', `/api/v1/applications/${appName}/sync`, {
      prune:    true,
      strategy: { hook: { force: false } },
    })
    const syncOk = syncResult.status < 400
    if (syncOk) {
      console.log(`${tag} Sync triggered: ${appName}`)
    } else {
      console.warn(`${tag} Sync warning (${syncResult.status}):`, syncResult.body)
    }

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

// ── GET /status/:appName ─────────────────────────────────
// Application 상태 조회 (프록시)

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

// ── GET /health ───────────────────────────────────────────

app.get('/health', (_, res) => {
  res.json({ ok: true, argocd: ARGOCD_SERVER || 'not configured' })
})

// ── 시작 ─────────────────────────────────────────────────

function validateEnv() {
  if (!ARGOCD_SERVER)      throw new Error('ARGOCD_SERVER is required')
  if (!ARGOCD_ADMIN_TOKEN) throw new Error('ARGOCD_ADMIN_TOKEN is required')
  if (!REGISTER_SECRET)    throw new Error('REGISTER_SECRET is required')
}

try {
  validateEnv()
  app.listen(Number(PORT), () => {
    console.log(`Grad-Deploy Registration Service  :${PORT}`)
    console.log(`Argo CD target: ${ARGOCD_SERVER}`)
    console.log('Endpoints: POST /register  GET /status/:app  GET /health')
  })
} catch (err) {
  console.error('Config error:', err.message)
  process.exit(1)
}
