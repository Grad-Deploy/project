#!/bin/bash
# ════════════════════════════════════════════════════════════
#  현재 활성 cloudflared 터널 URL 빠르게 확인
#  실행: bash show-urls.sh
# ════════════════════════════════════════════════════════════

YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
NC='\033[0m'

SESSION_NAME="graddeploy"

if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "tmux 세션이 실행 중이지 않습니다."
  echo "먼저 다음을 실행하세요:"
  echo "  bash start-grad-deploy.sh"
  exit 1
fi

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}   cloudflared 터널 URL${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

extract_url() {
  local window=$1
  tmux capture-pane -t "$SESSION_NAME":"$window" -p 2>/dev/null | \
    grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1
}

ARGOCD_URL=$(extract_url cf-argocd)
BACKEND_URL=$(extract_url cf-backend)
FRONTEND_URL=$(extract_url cf-frontend)
MINIBOARD_URL=$(extract_url cf-miniboard)

echo ""
echo -e "  ${YELLOW}ArgoCD UI:${NC}   ${ARGOCD_URL:-(없음 - tmux cf-argocd 창 확인)}"
echo -e "  ${YELLOW}Backend:${NC}     ${BACKEND_URL:-(없음 - tmux cf-backend 창 확인)}"
echo -e "  ${YELLOW}Frontend:${NC}    ${FRONTEND_URL:-(없음 - tmux cf-frontend 창 확인)}"
echo -e "  ${YELLOW}Mini Board:${NC}   ${MINIBOARD_URL:-(배포 대기 중... 배포 완료 시 자동 활성화되며 tmux cf-miniboard 창 확인)}"
echo ""

ARGOCD_PASSWORD=$(kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
if [ -n "$ARGOCD_PASSWORD" ]; then
  echo -e "  ${YELLOW}ArgoCD admin 비밀번호:${NC} $ARGOCD_PASSWORD"
  echo ""
fi

if [ -n "$ARGOCD_URL" ]; then
  echo -e "  ${GREEN}GitHub OAuth App callback URL:${NC}"
  echo "    ${ARGOCD_URL}/api/dex/callback"
  echo ""
fi
