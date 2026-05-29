#!/bin/bash
# ════════════════════════════════════════════════════════════
#  Mini Board 로컬 실시간 자동 동기화 & 핫 리로드 스크립트
# ════════════════════════════════════════════════════════════

PROJECT_DIR="/mnt/c/Users/user/OneDrive/바탕 화면/project-fix-bugs"
BACKEND_DIR="$PROJECT_DIR/sample-apps/backend"
FRONTEND_DIR="$PROJECT_DIR/sample-apps/frontend"

# 기본 매핑 인자 (사용자 환경에 맞춰 자동 감지 및 기본값 설정)
GH_USER="${1:-leesean2}"
NS="${2:-default}"
SVC_FRONTEND="${3:-react-nginx-svc}"
SVC_BACKEND="${4:-node-svc}"

# K8s deploy 상의 이미지 명칭 매핑 규격 (k8s_improved.js 기준)
to_image_name() {
  local name=$1
  echo "${name/-svc/-service-v2}"
}

IMG_FE_FULL="ghcr.io/$GH_USER/$(to_image_name $SVC_FRONTEND)"
IMG_BE_FULL="ghcr.io/$GH_USER/$(to_image_name $SVC_BACKEND)"

echo "========================================================"
echo "  Mini Board Local Auto-Sync (Hot Reload) Watcher"
echo "========================================================"
echo "  * Project Dir:  $PROJECT_DIR"
echo "  * GitHub User:  $GH_USER"
echo "  * Namespace:    $NS"
echo "  * FE Image:     $IMG_FE_FULL:latest"
echo "  * BE Image:     $IMG_BE_FULL:latest"
echo "--------------------------------------------------------"
echo "   sample-apps/ 폴더 감시 중... (Ctrl+C로 종료)"
echo "========================================================"

get_last_modified() {
  find "$BACKEND_DIR" "$FRONTEND_DIR" -type f -exec stat -c %Y {} + 2>/dev/null | sort -n | tail -1
}

LAST_MOD=$(get_last_modified)

while true; do
  sleep 1.5
  CURRENT_MOD=$(get_last_modified)
  if [ "$CURRENT_MOD" != "$LAST_MOD" ]; then
    echo ""
    echo "[$(date '+%H:%M:%S')] ⚡ 변경 감지! 동기화를 시작합니다..."
    
    # 1. 백엔드 빌드 및 Kind 로드
    echo "  -> 1. 백엔드 이미지 빌드 중..."
    if docker build -t "$SVC_BACKEND:latest" -t "$IMG_BE_FULL:latest" "$BACKEND_DIR"; then
      echo "  -> 2. 백엔드 이미지 Kind 로딩 중..."
      kind load docker-image "$IMG_BE_FULL:latest" --name grad-deploy
    else
      echo "  [오류] 백엔드 빌드 실패"
      continue
    fi
    
    # 2. 프론트엔드 빌드 및 Kind 로드
    echo "  -> 3. 프론트엔드 이미지 빌드 중..."
    if docker build -t "$SVC_FRONTEND:latest" -t "$IMG_FE_FULL:latest" "$FRONTEND_DIR"; then
      echo "  -> 4. 프론트엔드 이미지 Kind 로딩 중..."
      kind load docker-image "$IMG_FE_FULL:latest" --name grad-deploy
    else
      echo "  [오류] 프론트엔드 빌드 실패"
      continue
    fi
    
    # 3. Kubernetes 디플로이먼트 롤아웃 재시작
    echo "  -> 5. Kubernetes 리소스 재시작 (Rollout Restart)..."
    kubectl rollout restart deployment/"$SVC_BACKEND" -n "$NS"
    kubectl rollout restart deployment/"$SVC_FRONTEND" -n "$NS"
    
    LAST_MOD=$CURRENT_MOD
    echo "[성공] 🎉 동기화 완료! 브라우저를 새로고침 하세요."
    echo "--------------------------------------------------------"
  fi
done
