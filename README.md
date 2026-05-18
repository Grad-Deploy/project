# Grad-Deploy v2

**Policy-as-Code 기반 K8s 운영 안전망 플랫폼**

6대 가드레일 엔진으로 Kubernetes 설정 오류를 사전에 차단하고, GitOps 기반으로 안전하게 배포합니다.

---

## 시작하기

```bash
npm install
npm run dev
```

브라우저에서 http://localhost:5173 을 열어주세요.

## 빌드

```bash
npm run build
npm run preview
```

---

## 주요 기능

| 탭 | 기능 |
|---|---|
| 서비스 | K8s 서비스 구성 + 실시간 가드레일 피드백 |
| 가드레일 | RA / GE / PG / NA / VE 엔진 결과 |
| 토폴로지 | 서비스 의존성 SVG DAG 시각화 |
| 크레딧 | 클라우드 비용 예측 + D-day 표시 |
| 데모데이 | 공개 URL + 실시간 Pod 상태 대시보드 |
| 배포 | GitHub Push + Argo CD 자동 동기화 |
| **멀티유저** | **App-of-Apps 패턴 기반 다중 사용자 GitOps** |

---

## 배포 플로우 (단일 사용자)

```
npm run dev
    │
    ▼
[배포 탭]
  1. GitHub PAT 입력 → 계정 인증
  2. 레포 선택 (기존) 또는 신규 생성
  3. Argo CD 서버 URL + 토큰 입력
     └─ 레포 미생성 상태면 "배포 시 자동 등록" 모드로 저장
  4. 배포 버튼 클릭
     ├─ (신규 레포) 레포 생성
     ├─ ARGOCD_SERVER Variable 등록
     ├─ ARGOCD_TOKEN Secret 등록
     ├─ Argo CD Webhook 등록
     └─ k8s/, .github/workflows/ci.yml, argo-app.yaml 푸시
    │
    ▼
[GitHub Actions CI — 자동 실행]
  build-{svc}      → Docker 이미지 빌드 & 레지스트리 푸시
  validate         → kubectl dry-run
  update-tags      → kustomization.yaml 이미지 태그 업데이트 & 커밋
  sync-argocd      → Argo CD Application 존재 확인 → 없으면 자동 생성 → Sync 트리거
    │
    ▼
[Argo CD] 자동 동기화 → 클러스터 반영
```

### GitHub Actions CI 구조

```yaml
jobs:
  build-{svc}:    # 서비스별 병렬 빌드 (GHCR 또는 Docker Hub)
  validate:       # kubectl apply --dry-run=client
  update-tags:    # kustomization.yaml 이미지 태그 패치 & 커밋
  sync-argocd:    # Application 자동 생성 + Sync API 호출
```

### 생성되는 K8s 파일 구조

```
k8s/
├── base/
│   └── {svc}/
│       ├── deployment.yaml
│       ├── service.yaml
│       └── kustomization.yaml
└── overlays/
    └── production/
        └── kustomization.yaml   ← 이미지 태그 자동 업데이트
.github/
└── workflows/
    └── ci.yml
argo-app.yaml
```

### 컨테이너 레지스트리

| 옵션 | 설정 |
|---|---|
| GHCR (기본) | GitHub Container Registry — PAT 재사용 |
| Docker Hub | Docker Hub 사용자명 + Access Token 별도 입력 |

---

## 멀티유저 GitOps (App-of-Apps 패턴)

여러 사용자의 애플리케이션을 단일 Argo CD 인스턴스에서 격리하여 관리합니다.

### 동작 방식

```
[Control 레포 — apps/]
  root-app.yaml              ← Argo CD가 이 Application을 감시
      │
      ├── apps/user1-app.yaml      → user1의 레포 k8s/overlays/production 배포
      ├── apps/user1-project.yaml  → user1 전용 AppProject (격리)
      ├── apps/user2-app.yaml
      └── apps/user2-project.yaml
```

### 사용 방법

1. **[멀티유저 탭]** 접속
2. Control 레포 입력 (`owner/repo` 형식, 없으면 자동 생성)
3. 사용자 추가: 이름 / Namespace / 레포 URL 입력
4. GitHub PAT 입력
5. (선택) Argo CD 서버 URL + 토큰 입력 → root-app 자동 생성
6. **Control 레포 배포** 버튼 클릭

Argo CD 연결을 생략한 경우:
```bash
kubectl apply -f root-app.yaml
```

### 생성 파일

| 파일 | 역할 |
|---|---|
| `root-app.yaml` | control 레포의 `apps/` 폴더를 감시하는 루트 Application |
| `apps/{name}-app.yaml` | 사용자 레포 → 사용자 namespace로 배포하는 Application |
| `apps/{name}-project.yaml` | sourceRepo / destination을 해당 사용자로 제한하는 AppProject |

### 격리 구조

각 사용자는 독립된 AppProject를 가지며, 자신의 레포와 namespace에만 배포할 수 있습니다.

```yaml
# apps/user1-project.yaml
spec:
  sourceRepos:
    - "https://github.com/user1/my-app"   # user1 레포만 허용
  destinations:
    - namespace: "user1-ns"               # user1 namespace만 허용
      server: https://kubernetes.default.svc
```

---

## Argo CD 초기 설정 (선행 준비)

```bash
# 1. Minikube 시작
minikube start

# 2. Argo CD 설치
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# 3. 포트 포워딩
kubectl port-forward svc/argocd-server -n argocd 8080:443 &

# 4. 외부 접속 (ngrok 사용 시)
ngrok http https://localhost:8080

# 5. argocd-cm에 외부 URL 등록 (ngrok URL 변경 시마다 갱신)
kubectl patch configmap argocd-cm -n argocd \
  --patch '{"data":{"url":"https://<ngrok-url>"}}'
kubectl rollout restart deployment argocd-server -n argocd

# 6. 토큰 발급
argocd login <ngrok-url> --username admin --password <password> --insecure
argocd account generate-token
```

> **주의:** ngrok URL이 변경될 때마다 argocd-cm의 `url` 필드를 갱신하고 서버를 재시작해야 합니다. URL 불일치 시 JWT issuer 검증 오류(HTTP 403)가 발생합니다.

---

## 프로젝트 구조

```
src/
├── engines/
│   └── guardrail.js           # 6대 가드레일 엔진 (순수 함수)
├── generators/
│   ├── k8s.js                 # K8s YAML / GitHub Actions CI / Argo CD Application 생성기
│   └── multiUser.js           # App-of-Apps YAML 생성기 (root-app / user-app / AppProject)
├── hooks/
│   └── useStore.js            # 전역 상태 (useReducer)
└── components/
    ├── Ui.jsx                 # 원자 컴포넌트 (Input, Select, Toggle, YamlCode)
    ├── ServiceCard.jsx        # 서비스 설정 카드
    ├── GuardrailPanel.jsx     # 가드레일 결과
    ├── NetworkTopology.jsx    # 토폴로지 시각화
    ├── CreditPanel.jsx        # 크레딧 예측
    ├── DemoMode.jsx           # 데모데이 모드
    ├── DeployPanel.jsx        # 단일 사용자 GitHub Push + Argo CD Sync
    └── MultiUserPanel.jsx     # 멀티유저 App-of-Apps 배포
```

---

## 가드레일 엔진

| 엔진 | 역할 |
|---|---|
| RA (Resource Advisor) | CPU/Memory 요청·제한 미설정 경고 |
| GE (Guardrail Engine) | 보안 컨텍스트, privileged 컨테이너 감지 |
| PG (Probe Guard) | Liveness/Readiness Probe 누락 경고 |
| NA (Namespace Advisor) | 네임스페이스 미분리 경고 |
| VE (Volume Engine) | 스토리지 설정 오류 감지 |
| NetworkPolicy | 서비스 간 통신 정책 자동 생성 |

---

## 기술 스택

- **Frontend:** React 18 + Vite
- **상태 관리:** useReducer (Flux 패턴)
- **YAML 생성:** 순수 JS 템플릿 리터럴
- **GitHub 연동:** GitHub REST API (Contents / Secrets / Variables / Webhooks)
- **Argo CD 연동:** Argo CD REST API (`/api/v1/applications`)
- **암호화:** libsodium (GitHub Secret 암호화용)
