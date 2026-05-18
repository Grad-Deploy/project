import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { exec } from 'child_process'

// ── 기존 터미널 실행 플러그인 (변경 없음) ─────────────
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

// ════════════════════════════════════════════════════════
//  ArgoCD CORS 우회 Proxy
//
//  ArgoCD server 는 외부 origin 에서의 API 호출을 위해
//  Access-Control-Allow-Origin 헤더를 보내지 않습니다.
//  (ArgoCD 의 의도된 보안 설계 — same-origin 전용 admin UI)
//
//  Vite dev server 를 proxy 로 사용하면:
//    브라우저 → localhost:5173 (same-origin, CORS 검사 안 일어남)
//             → 서버↔서버 forward (CORS 무관)
//             → ArgoCD (https://*.trycloudflare.com)
//
//  사용 방법:
//    클라이언트(argoAutoSetup.js)에서 fetch 시
//      URL: /argocd-api/api/v1/session
//      Header: X-Argocd-Target: https://copy-rocket-courts-dogs.trycloudflare.com
//
//    → 이 proxy 가 헤더의 target URL 로 요청을 forward
//    → cloudflare quick tunnel URL 이 매번 바뀌어도 vite.config.js 수정 불필요
// ════════════════════════════════════════════════════════
const argocdProxyPlugin = () => ({
  name: 'argocd-proxy',
  configureServer(server) {
    server.middlewares.use('/argocd-api', async (req, res) => {
      // 1) 클라이언트가 보낸 X-Argocd-Target 헤더에서 실제 ArgoCD URL 추출
      const targetUrl = req.headers['x-argocd-target']
      if (!targetUrl) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({
          error: 'X-Argocd-Target 헤더가 누락되었습니다',
          hint: 'argoAutoSetup.js 에서 ArgoCD URL 을 헤더에 담아 보내야 합니다',
        }))
        return
      }

      // 2) 경로 재작성: /argocd-api/api/v1/session → /api/v1/session
      //    Vite middleware 가 '/argocd-api' prefix 를 이미 떼고 req.url 로 전달함
      const targetPath = req.url
      const fullTargetUrl = `${targetUrl.replace(/\/+$/, '')}${targetPath}`

      // 3) Node fetch 로 ArgoCD 에 요청 forward
      //    - cloudflare quick tunnel 은 Let's Encrypt 정상 인증서를 갖고 있어
      //      별도 TLS 처리 불필요
      try {
        // 요청 body 수집 (POST/PUT 시 필요)
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = chunks.length ? Buffer.concat(chunks) : undefined

        // forward 할 헤더 정리:
        //   X-Argocd-Target 은 ArgoCD 가 모르는 헤더이므로 제거
        //   host 헤더는 fetch 가 자동 설정 (인증서 검증 충돌 방지)
        //   content-length 는 body 가 바뀔 수 있으므로 fetch 가 재계산하도록 제거
        //   accept-encoding 은 제거 — Node fetch 가 압축 응답을 자동 해제하지만
        //     이 후 다시 res.end() 로 전달할 때 body 가 raw 인 상태로 나가므로,
        //     ArgoCD 에 압축 응답을 요청하지 않도록 미리 차단 (Unterminated string 방지)
        const forwardHeaders = { ...req.headers }
        delete forwardHeaders['x-argocd-target']
        delete forwardHeaders.host
        delete forwardHeaders['content-length']
        delete forwardHeaders['accept-encoding']

        const upstream = await fetch(fullTargetUrl, {
          method: req.method,
          headers: forwardHeaders,
          body,
          redirect: 'manual',
        })

        // 4) ArgoCD 응답을 그대로 브라우저로 전달
        res.statusCode = upstream.status
        upstream.headers.forEach((v, k) => {
          // 제외해야 하는 헤더들:
          //   content-encoding: Node fetch 가 이미 압축 해제했으므로 클라가 다시 해제하면 깨짐
          //   content-length: 압축 해제로 length 가 바뀌었을 수 있어 mismatch → JSON 잘림
          //   transfer-encoding / connection: hop-by-hop 헤더 (Node http 가 자체 관리)
          const lower = k.toLowerCase()
          if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(lower)) {
            res.setHeader(k, v)
          }
        })
        const responseBody = Buffer.from(await upstream.arrayBuffer())
        res.end(responseBody)
      } catch (e) {
        // ArgoCD 서버 자체에 접근 불가 (cloudflared 다운, URL 만료 등)
        res.statusCode = 502
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({
          error: `Proxy forward 실패: ${e.message}`,
          target: fullTargetUrl,
          hint: 'cloudflared tunnel 이 활성 상태인지 확인하세요',
        }))
      }
    })
  },
})

export default defineConfig({
  plugins: [react(), terminalPlugin(), argocdProxyPlugin()],
})
