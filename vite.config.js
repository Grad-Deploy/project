import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { exec } from 'child_process'
import { promisify } from 'util'
import http from 'http'
import https from 'https'

const execAsync = promisify(exec)

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function toK8sName(value, fallback = 'my-app') {
  const normalized = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .replace(/[-.]{2,}/g, '-')
  return normalized || fallback
}

// ── 기존 터미널 실행 플러그인 (변경 없음) ─────────────
// 클라이언트에서 /api/exec 호출 시 Vite dev server 가 셸 명령 실행
// (개발용. production 빌드에선 동작 안 함)
const terminalPlugin = () => ({
  name: 'terminal-executor',
  configureServer(server) {
    server.middlewares.use('/api/exec', (req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { cmd } = JSON.parse(body);
            exec(cmd, (err, stdout, stderr) => {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err ? err.message : null, stdout, stderr }));
            });
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
      }
    });
  }
})

const argocdProxyPlugin = () => ({
  name: 'argocd-dev-proxy',
  configureServer(server) {
    server.middlewares.use('/argocd-api', async (req, res) => {
      const targetUrl = req.headers['x-argocd-target']
      if (!targetUrl) {
        return sendJson(res, 400, {
          error: 'X-Argocd-Target 헤더가 누락되었습니다',
          hint: 'Argo CD URL 이 프록시로 전달되지 않았습니다',
        })
      }

      const targetPath = req.url || '/'
      const fullTargetUrl = `${String(targetUrl).replace(/\/+$/, '')}${targetPath}`

      try {
        const rawBody = ['GET', 'HEAD'].includes(req.method || 'GET')
          ? undefined
          : await readBody(req)
        const target = new URL(fullTargetUrl)
        const isHttps = target.protocol === 'https:'
        const mod = isHttps ? https : http
        const forwardHeaders = { ...req.headers }
        delete forwardHeaders['x-argocd-target']
        delete forwardHeaders.host
        delete forwardHeaders['accept-encoding']
        delete forwardHeaders.connection
        if (rawBody) forwardHeaders['content-length'] = rawBody.length

        const upstream = await new Promise((resolve, reject) => {
          const proxyReq = mod.request({
            hostname: target.hostname,
            port: target.port || (isHttps ? 443 : 80),
            path: target.pathname + target.search,
            method: req.method,
            headers: forwardHeaders,
            rejectUnauthorized: false,
          }, proxyRes => {
            const chunks = []
            proxyRes.on('data', chunk => chunks.push(chunk))
            proxyRes.on('end', () => resolve({
              status: proxyRes.statusCode || 502,
              headers: proxyRes.headers,
              body: Buffer.concat(chunks),
            }))
          })
          proxyReq.on('error', reject)
          if (rawBody) proxyReq.write(rawBody)
          proxyReq.end()
        })

        res.statusCode = upstream.status
        Object.entries(upstream.headers).forEach(([k, v]) => {
          const lower = k.toLowerCase()
          if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(lower)) {
            res.setHeader(k, v)
          }
        })
        res.end(upstream.body)
      } catch (e) {
        const targetHost = (() => {
          try { return new URL(fullTargetUrl).hostname } catch (_) { return '' }
        })()
        sendJson(res, 502, {
          error: `ArgoCD dev proxy 실패: ${e.message}`,
          target: fullTargetUrl,
          hint: targetHost === 'localhost' || targetHost === '127.0.0.1'
            ? 'localhost 는 Vite dev server 기준입니다. kubectl port-forward 가 떠 있는지 확인하세요.'
            : 'Argo CD URL 이 활성 상태인지 확인하세요.',
        })
      }
    })
  },
})

const bootstrapPlugin = () => ({
  name: 'argocd-bootstrap-dev',
  configureServer(server) {
    server.middlewares.use('/api/bootstrap', async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        return res.end('Method Not Allowed')
      }

      let body
      try {
        body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      } catch (_) {
        return sendJson(res, 400, { error: '잘못된 JSON 요청입니다' })
      }

      const { proj, repoUrl, ghUser, pat, namespace } = body
      const safePattern = /^[a-zA-Z0-9_-]+$/
      if (!safePattern.test(proj || '')) {
        return sendJson(res, 400, { error: '잘못된 proj 형식 (영숫자/하이픈/언더스코어만 허용)' })
      }
      if (!safePattern.test(ghUser || '')) {
        return sendJson(res, 400, { error: '잘못된 ghUser 형식' })
      }
      if (!/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/.test(repoUrl || '')) {
        return sendJson(res, 400, { error: '잘못된 repoUrl 형식 (https://github.com/owner/repo)' })
      }
      if (!/^(ghp_|github_pat_)[\w]+$/.test(pat || '')) {
        return sendJson(res, 400, { error: '잘못된 PAT 형식' })
      }

      const ns = (namespace && safePattern.test(namespace)) ? namespace : 'argocd'
      const rawUrl = repoUrl.replace('github.com', 'raw.githubusercontent.com')
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

      const steps = [
        {
          name: 'Repository Secret 생성',
          cmd: `kubectl create secret generic "\${SAFE_PROJ}-git-repo-creds" -n "\${NS}" --from-literal=type="git" --from-literal=url="\${REPO_URL}" --from-literal=username="\${GH_USER}" --from-literal=password="\${PAT}" --dry-run=client -o yaml | kubectl apply --validate=false -f -`,
        },
        {
          name: 'Repository Secret 레이블 지정',
          cmd: `kubectl label secret "\${SAFE_PROJ}-git-repo-creds" -n "\${NS}" argocd.argoproj.io/secret-type=repository --overwrite`,
        },
        {
          name: 'AppProject 적용',
          cmd: `curl -fsSL -H "Authorization: token \${PAT}" "\${RAW_URL}/main/k8s/projects/\${PROJ}/argo-project.yaml" | kubectl apply --validate=false -n "\${NS}" -f -`,
        },
        {
          name: '부모 Application 적용',
          cmd: `curl -fsSL -H "Authorization: token \${PAT}" "\${RAW_URL}/main/k8s/projects/\${PROJ}/argo-parent-app.yaml" | kubectl apply --validate=false -n "\${NS}" -f -`,
        },
        {
          name: 'ApplicationSet 적용',
          cmd: `curl -fsSL -H "Authorization: token \${PAT}" "\${RAW_URL}/main/k8s/projects/\${PROJ}/argo-appset.yaml" | kubectl apply --validate=false -n "\${NS}" -f -`,
        },
      ]

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
          return sendJson(res, 500, { ok: false, steps: results })
        }
      }

      sendJson(res, 200, { ok: true, steps: results })
    })
  },
})

// ════════════════════════════════════════════════════════
//  ArgoCD CORS proxy 및 kubectl bootstrap 요청을
//  백엔드 server/index.js (localhost:4000) 로 forward
//
//  환경변수:
//    VITE_BACKEND_URL  - 백엔드 URL (기본 http://localhost:4000)
// ════════════════════════════════════════════════════════
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendUrl = env.VITE_BACKEND_URL || 'http://localhost:4000'

  return {
    plugins: [react(), terminalPlugin(), argocdProxyPlugin(), bootstrapPlugin()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      // cloudflared trycloudflare.com 도메인 허용
      allowedHosts: ['.trycloudflare.com', '.kloud.zone', 'localhost'],
      proxy: {
        '/register': {
          target: backendUrl,
          changeOrigin: true,
          secure: false,
        },
        '/status': {
          target: backendUrl,
          changeOrigin: true,
          secure: false,
        },
      },
    },
  }
})
