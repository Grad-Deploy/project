import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { exec } from 'child_process'

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
    plugins: [react(), terminalPlugin()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      // cloudflared trycloudflare.com 도메인 허용
      allowedHosts: ['.trycloudflare.com', '.kloud.zone', 'localhost'],
      proxy: {
        '/argocd-api': {
          target: backendUrl,
          changeOrigin: true,
          secure: false,
        },
        '/api/bootstrap': {
          target: backendUrl,
          changeOrigin: true,
          secure: false,
        },
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
