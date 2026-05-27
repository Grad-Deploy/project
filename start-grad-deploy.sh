#!/bin/bash
# ════════════════════════════════════════════════════════════
#  Grad-Deploy 전체 환경 시작 스크립트
#
#  실행: bash ~/start-grad-deploy.sh
#
#  자동으로 수행:
#    1. Docker 데몬 확인 (자동 시작)
#    2. kind 클러스터 상태 확인 (필요 시 재시작)
#    3. ArgoCD 상태 확인 + 비밀번호 출력
#    4. tmux 세션 생성 + 6개 창에 자동 실행
#
#  tmux 단축키:
#    Ctrl+B → 화살표  : 창 간 이동
#    Ctrl+B → D       : 세션 분리 (백그라운드 유지)
#    Ctrl+B → [       : 스크롤 모드 (q 로 나가기)
#  세션 재접속:
#    tmux attach -t graddeploy
# ════════════════════════════════════════════════════════════

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── 프로젝트 디렉토리 자동 감지 ───────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/package.json" ] && [ -d "$SCRIPT_DIR/server" ]; then
  PROJECT_DIR="$SCRIPT_DIR"
elif [ -d "/c/Users/user/OneDrive/바탕 화면/capstone" ]; then
  PROJECT_DIR="/c/Users/user/OneDrive/바탕 화면/capstone"
elif [ -d "/c/Users/user/OneDrive/Desktop/capstone" ]; then
  PROJECT_DIR="/c/Users/user/OneDrive/Desktop/capstone"
elif [ -d "/c/Users/user/Desktop/capstone" ]; then
  PROJECT_DIR="/c/Users/user/Desktop/capstone"
elif [ -d "/c/Users/user/Downloads/capstone-main/capstone-main" ]; then
  PROJECT_DIR="/c/Users/user/Downloads/capstone-main/capstone-main"
else
  PROJECT_DIR="/c/Users/user/OneDrive/바탕 화면/capstone"
fi

SERVER_DIR="$PROJECT_DIR/server"
SESSION_NAME="graddeploy"

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}   Grad-Deploy 환경 시작${NC}"
echo -e "${CYAN}   프로젝트 경로: $PROJECT_DIR${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ ! -d "$PROJECT_DIR" ]; then
  echo -e "${RED}✗ 프로젝트 디렉토리 없음: $PROJECT_DIR${NC}"
  exit 1
fi
if [ ! -d "$SERVER_DIR" ]; then
  echo -e "${RED}✗ 백엔드 디렉토리 없음: $SERVER_DIR${NC}"
  exit 1
fi


if ! command -v tmux >/dev/null 2>&1; then
  echo -e "${YELLOW}⚠ tmux 미설치. 설치 중...${NC}"
  sudo apt update && sudo apt install -y tmux
fi

for cmd in docker kubectl kind cloudflared node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo -e "${RED}✗ $cmd 명령어가 없습니다${NC}"
    exit 1
  fi
done

echo -e "${GREEN}✓ 사전 점검 완료${NC}"
echo ""

echo -e "${BLUE}[1/4] Docker 확인...${NC}"
if ! docker info >/dev/null 2>&1; then
  echo -e "${YELLOW}⚠ Docker 데몬 미실행. 시작 중...${NC}"
  sudo systemctl start docker
  sleep 5
  if ! docker info >/dev/null 2>&1; then
    echo -e "${RED}✗ Docker 시작 실패${NC}"
    exit 1
  fi
fi
echo -e "${GREEN}✓ Docker 실행 중${NC}"

echo ""
echo -e "${BLUE}[2/4] kind 클러스터 확인...${NC}"

if ! kind get clusters 2>/dev/null | grep -q '^grad-deploy$'; then
  echo -e "${RED}✗ grad-deploy 클러스터가 없습니다${NC}"
  echo -e "${YELLOW}  클러스터를 생성하려면:${NC}"
  echo "  kind create cluster --name grad-deploy"
  echo ""
  echo -e "${YELLOW}  ArgoCD 도 다시 설치 필요:${NC}"
  echo "  kubectl create namespace argocd"
  echo "  kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v2.13.2/manifests/install.yaml"
  echo "  kubectl -n argocd patch deployment argocd-server --type='json' \\"
  echo "    -p='[{\"op\":\"add\",\"path\":\"/spec/template/spec/containers/0/args/-\",\"value\":\"--insecure\"}]'"
  exit 1
fi

CTRL_CONTAINER=$(docker ps -a --filter "name=grad-deploy-control-plane" --format "{{.Status}}" | head -1)
if [[ "$CTRL_CONTAINER" == Exited* ]]; then
  echo -e "${YELLOW}⚠ kind 컨테이너 정지 상태. 재시작 중...${NC}"
  docker start grad-deploy-control-plane
  docker ps -a --filter "name=grad-deploy-worker" --format "{{.Names}}" | while read worker; do
    [ -n "$worker" ] && docker start "$worker"
  done
  echo "  클러스터 준비 대기 (최대 60초)..."
  for i in {1..30}; do
    if kubectl get nodes >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
fi

if ! kubectl get nodes >/dev/null 2>&1; then
  echo -e "${RED}✗ 클러스터에 접근할 수 없습니다${NC}"
  echo "  kubectl config use-context kind-grad-deploy"
  exit 1
fi
echo -e "${GREEN}✓ kind 클러스터 정상${NC}"

echo ""
echo -e "${BLUE}[3/4] ArgoCD 상태 확인...${NC}"

if ! kubectl get namespace argocd >/dev/null 2>&1; then
  echo -e "${RED}✗ argocd namespace 없음${NC}"
  echo -e "${YELLOW}  ArgoCD 설치 필요:${NC}"
  echo "  kubectl create namespace argocd"
  echo "  kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v2.13.2/manifests/install.yaml"
  exit 1
fi

ARGOCD_READY=$(kubectl get deployment argocd-server -n argocd -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
if [ "$ARGOCD_READY" != "1" ]; then
  echo -e "${YELLOW}⚠ ArgoCD 시작 대기 중...${NC}"
  kubectl wait --for=condition=available --timeout=180s deployment/argocd-server -n argocd || {
    echo -e "${RED}✗ ArgoCD 시작 실패${NC}"
    exit 1
  }
fi
echo -e "${GREEN}✓ ArgoCD 실행 중${NC}"

ARGOCD_PASSWORD=$(kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
if [ -n "$ARGOCD_PASSWORD" ]; then
  echo ""
  echo -e "${CYAN}  ArgoCD admin 비밀번호:${NC} ${YELLOW}$ARGOCD_PASSWORD${NC}"
fi

echo ""
echo -e "${BLUE}[4/4] 기존 프로세스 정리...${NC}"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "  기존 tmux 세션 종료..."
  tmux kill-session -t "$SESSION_NAME"
fi

pkill -f "cloudflared tunnel" 2>/dev/null && echo "  cloudflared 정리됨" || true
pkill -f "kubectl port-forward.*argocd" 2>/dev/null && echo "  port-forward 정리됨" || true
pkill -f "node.*server/index.js" 2>/dev/null && echo "  백엔드 정리됨" || true
pkill -f "node --watch index.js" 2>/dev/null || true
pkill -f "vite" 2>/dev/null && echo "  Vite 정리됨" || true
sleep 2

echo -e "${GREEN}✓ 정리 완료${NC}"

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}   tmux 세션 생성 + 서비스 자동 실행${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

tmux new-session -d -s "$SESSION_NAME" -n main
tmux send-keys -t "$SESSION_NAME":main "clear" C-m
tmux send-keys -t "$SESSION_NAME":main "echo '━━━━ Grad-Deploy 메인 작업창 ━━━━'" C-m
tmux send-keys -t "$SESSION_NAME":main "echo ''" C-m
tmux send-keys -t "$SESSION_NAME":main "echo 'ArgoCD admin 비밀번호: $ARGOCD_PASSWORD'" C-m
tmux send-keys -t "$SESSION_NAME":main "echo ''" C-m

tmux new-window -t "$SESSION_NAME" -n pf-argocd
tmux send-keys -t "$SESSION_NAME":pf-argocd \
  "kubectl port-forward svc/argocd-server -n argocd 18080:80 --address 127.0.0.1" C-m

sleep 3

tmux new-window -t "$SESSION_NAME" -n backend
tmux send-keys -t "$SESSION_NAME":backend "cd $SERVER_DIR" C-m
tmux send-keys -t "$SESSION_NAME":backend "npm install && npm run dev" C-m

tmux new-window -t "$SESSION_NAME" -n frontend
tmux send-keys -t "$SESSION_NAME":frontend "cd $PROJECT_DIR" C-m
tmux send-keys -t "$SESSION_NAME":frontend "npm run dev" C-m

sleep 5

tmux new-window -t "$SESSION_NAME" -n cf-argocd
tmux send-keys -t "$SESSION_NAME":cf-argocd \
  "cloudflared tunnel --url http://127.0.0.1:18080 --http-host-header localhost:18080" C-m

tmux new-window -t "$SESSION_NAME" -n cf-backend
tmux send-keys -t "$SESSION_NAME":cf-backend \
  "cloudflared tunnel --url http://127.0.0.1:4000 --http-host-header localhost:4000" C-m

tmux new-window -t "$SESSION_NAME" -n cf-frontend
tmux send-keys -t "$SESSION_NAME":cf-frontend \
  "cloudflared tunnel --url http://127.0.0.1:5173 --http-host-header localhost:5173" C-m

tmux new-window -t "$SESSION_NAME" -n cf-ingress
tmux send-keys -t "$SESSION_NAME":cf-ingress \
  "cloudflared tunnel --url http://127.0.0.1:80 --http-host-header localhost:80" C-m

echo ""
echo "  cloudflared 터널 URL 발급 대기 (15초)..."
sleep 15

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
INGRESS_URL=$(extract_url cf-ingress)

echo ""
echo -e "  ${YELLOW}ArgoCD:${NC}               ${ARGOCD_URL:-(URL 발급 대기 중... tmux cf-argocd 창 확인)}"
echo -e "  ${YELLOW}Backend:${NC}              ${BACKEND_URL:-(URL 발급 대기 중... tmux cf-backend 창 확인)}"
echo -e "  ${YELLOW}Frontend:${NC}             ${FRONTEND_URL:-(URL 발급 대기 중... tmux cf-frontend 창 확인)}"
echo -e "  ${YELLOW}Demo App (Ingress):${NC}   ${INGRESS_URL:-(URL 발급 대기 중... tmux cf-ingress 창 확인)}"
echo ""

if [ -n "$FRONTEND_URL" ]; then
  tmux send-keys -t "$SESSION_NAME":main "echo '━━━━ 접속 URL ━━━━'" C-m
  tmux send-keys -t "$SESSION_NAME":main "echo 'ArgoCD:             ${ARGOCD_URL:-(확인 중)}'" C-m
  tmux send-keys -t "$SESSION_NAME":main "echo 'Backend:            ${BACKEND_URL:-(확인 중)}'" C-m
  tmux send-keys -t "$SESSION_NAME":main "echo 'Frontend:           ${FRONTEND_URL:-(확인 중)}'" C-m
  tmux send-keys -t "$SESSION_NAME":main "echo 'Demo App (Ingress): ${INGRESS_URL:-(확인 중)}'" C-m
  tmux send-keys -t "$SESSION_NAME":main "echo ''" C-m
fi

echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ 모든 서비스 시작됨${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "tmux 세션 접속:"
echo "  tmux attach -t $SESSION_NAME"
echo ""
echo "tmux 단축키:"
echo "  Ctrl+B → 0~6  : 창 번호로 이동"
echo "  Ctrl+B → N    : 다음 창"
echo "  Ctrl+B → P    : 이전 창"
echo "  Ctrl+B → D    : 세션 분리"
echo ""
echo "전체 종료:"
echo "  bash ~/stop-grad-deploy.sh"
echo ""

exec tmux attach -t "$SESSION_NAME":main
