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

## 주요 기능

| 탭 | 기능 |
|---|---|
| 서비스 | K8s 서비스 구성 + 실시간 가드레일 피드백 |
| 가드레일 | RA / GE / PG / NA / VE 엔진 결과 |
| 토폴로지 | 서비스 의존성 SVG DAG 시각화 |
| 크레딧 | 클라우드 비용 예측 + D-day 표시 |
| 데모데이 | 공개 URL + 실시간 Pod 상태 대시보드 |
| 배포 | GitHub Push + Argo CD Sync |

## 프로젝트 구조

```
src/
├── engines/guardrail.js       # 6대 가드레일 엔진 (순수 함수)
├── generators/k8s.js          # K8s YAML / CI / Argo CD 생성기
├── hooks/useStore.js          # 전역 상태 (useReducer)
└── components/
    ├── Ui.jsx                 # 원자 컴포넌트
    ├── ServiceCard.jsx        # 서비스 설정 카드
    ├── GuardrailPanel.jsx     # 가드레일 결과
    ├── NetworkTopology.jsx    # 토폴로지 시각화
    ├── CreditPanel.jsx        # 크레딧 예측
    ├── DemoMode.jsx           # 데모데이 모드
    └── DeployPanel.jsx        # GitHub Push
```
