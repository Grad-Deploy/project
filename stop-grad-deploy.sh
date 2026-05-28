#!/bin/bash
# ════════════════════════════════════════════════════════════
#  Grad-Deploy 전체 환경 종료 스크립트
#  실행: bash stop-grad-deploy.sh
# ════════════════════════════════════════════════════════════

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SESSION_NAME="graddeploy"

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}   Grad-Deploy 환경 종료${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux kill-session -t "$SESSION_NAME"
  echo -e "${GREEN}✓ tmux 세션 종료${NC}"
else
  echo -e "${YELLOW}- tmux 세션 없음${NC}"
fi

if pkill -f "cloudflared tunnel" 2>/dev/null; then
  echo -e "${GREEN}✓ cloudflared 종료${NC}"
else
  echo -e "${YELLOW}- cloudflared 없음${NC}"
fi

if pkill -f "kubectl port-forward.*argocd" 2>/dev/null; then
  echo -e "${GREEN}✓ kubectl port-forward 종료${NC}"
else
  echo -e "${YELLOW}- port-forward 없음${NC}"
fi

pkill -f "node.*server/index.js" 2>/dev/null
pkill -f "node --watch index.js" 2>/dev/null
pkill -f "node\.exe.*server/index.js" 2>/dev/null
pkill -f "node\.exe.*index.js" 2>/dev/null
echo -e "${GREEN}✓ 백엔드 서버 종료${NC}"

if pkill -f "vite" 2>/dev/null; then
  echo -e "${GREEN}✓ Vite 종료${NC}"
else
  echo -e "${YELLOW}- Vite 없음${NC}"
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ 모든 서비스 종료됨${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "참고: kind 클러스터와 ArgoCD 는 유지됨"
echo "  클러스터 상태: kubectl get nodes"
echo "  ArgoCD 상태:   kubectl get pod -n argocd"
echo ""
echo "다시 시작:"
echo "  bash start-grad-deploy.sh"
echo ""
