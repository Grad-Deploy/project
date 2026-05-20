# Grad-Deploy v2 작업 검증 보고서

- 작업 일자: 2026-05-20
- 프로젝트: Grad-Deploy v2
- 작업 환경: 로컬 Vite 개발 서버 + 실제 VM `leeon@127.0.0.1:2222`
- 기준 시각: 2026-05-20 Asia/Seoul

---

## 1. 구현 반영 내역

### 1. CA(Cluster Advisor) → RA(Guardrail) 연동

수정 파일:

- `src/App.jsx`
- `src/components/ClusterAdvisorPanel.jsx`
- `src/hooks/useStore_improved.js`
- `src/engines/guardrail.js`

검증 내용:

- `클러스터` 탭을 다시 노출했다.
- `ClusterAdvisorPanel` 결과를 `clusterCapacity`로 저장한다.
- RA가 replicas를 반영한 CPU/Memory request 총합을 계산한다.
- `RA-CA-00`, `RA-CA-01`, `RA-CA-02`로 배포 차단 조건을 추가했다.
- VM ARM64 환경에서 `Allocatable:` 블록을 `awk`로 안정적으로 수집하도록 스크립트를 수정했다.

### 2. Kubernetes/GitOps 생성기 안정화

수정 파일:

- `src/generators/k8s_improved.js`
- `src/App.jsx`
- `src/components/DeployPanel.jsx`

검증 내용:

- DB 서비스는 공식 이미지를 사용한다. 예: `mysql:8.0`
- 앱 서비스 overlay에는 `newName`과 `newTag: latest`가 함께 생성된다.
- CI는 `newTag:`가 없으면 실패하게 변경했다.
- GHCR private 이미지용 `imagePullSecrets: ghcr-pull-secret`을 Deployment에 추가했다.
- `setup-image-pull-secret.sh`를 생성해 VM에서 pull secret을 만들 수 있게 했다.
- 평문 Secret YAML은 생성하지 않는다.

### 3. GitHub push 단일 커밋화

수정 파일:

- `src/components/DeployPanel.jsx`

검증 내용:

- 파일별 Contents API PUT 대신 Git Data API 흐름으로 변경했다.
- blob/tree/commit/ref update 방식으로 전체 생성물을 한 번의 커밋에 반영한다.
- UI가 기대하는 `results.files` 배열 형태는 유지했다.

### 4. Argo CD 상태 UI 노출 및 조회

수정 파일:

- `src/components/DeployPanel.jsx`

검증 내용:

- 배포 탭 상단에 `Argo CD 상태` 카드가 항상 보인다.
- GitHub 인증 전에도 서버 URL, token, admin password, 새로고침 버튼이 표시된다.
- `GET /api/v1/applications`로 Application 상태를 조회한다.
- `sync`, `health`, revision, condition message를 표시한다.

---

## 2. 실제 VM 검증 결과

접속:

```bash
ssh -p 2222 leeon@127.0.0.1
```

확인 사항:

- VM 접속 성공
- Ubuntu 24.04 ARM64 확인
- `kubectl`, `docker`, `minikube` 설치 확인
- minikube docker driver 구동 확인
- Argo CD namespace 및 server pod 동작 확인
- Argo CD API `/api/v1/applications` 응답 확인

발견한 문제:

- `mysql-svc-0`: `ErrImagePull/ImagePullBackOff`
  - 원인: 기존 DB 이미지가 GHCR 앱 이미지로 생성되어 unauthorized 발생
  - 대응: DB 공식 이미지 사용 및 GHCR pull secret setup script 생성

- `spring-svc`: `Pending`
  - 원인: Kubernetes event에서 `Insufficient cpu` 확인
  - 대응: CA → RA 리소스 초과 차단 규칙 추가

- HPA metric 실패
  - 원인: `pods.metrics.k8s.io` API 없음
  - 대응 필요: metrics-server 설치 안내 또는 자동 검사 추가

- VM script memory 누락
  - 원인: `grep -A5 "Allocatable:"`가 ARM64 hugepages 라인 때문에 `memory:`를 놓침
  - 대응: `awk` 기반 Allocatable 블록 수집으로 수정

---

## 3. 로컬 검증 결과

실행한 검증:

```bash
npm run build
```

결과:

- Vite production build 성공
- 변환 모듈: 48개
- 번들 생성 성공

브라우저 확인:

- 로컬 서버: `http://localhost:5173/`
- 배포 탭 진입 성공
- `Argo CD 상태` 카드 노출 확인
- `Argo CD 서버 URL`, `Argo CD 토큰`, `admin 비밀번호` 입력 표시 확인
- `Argo CD 상태 새로고침` 버튼 표시 확인
- 브라우저 콘솔 error: 0개

---

## 4. 남은 검증 항목

| 항목 | 현재 상태 | 다음 액션 |
| :--- | :--- | :--- |
| GitHub Actions 실제 실행 | 코드 반영 완료, 실계정 push 미검증 | 테스트 repo에 push 후 CI 결과 확인 |
| GHCR image pull | setup script 생성 완료 | VM에서 `GHCR_USERNAME/GHCR_TOKEN`으로 script 실행 후 Pod 재배포 |
| Argo CD status | UI/API 호출 구현 완료 | CORS/tunnel 환경에서 실제 브라우저 호출 반복 검증 |
| Pod/Event dashboard | 미구현 | `/api/v1/applications/{name}/resource-tree` 또는 Kubernetes API 경로 검토 |
| HPA | metrics-server 부재 확인 | 설치 가이드 또는 사전 검사 추가 |
| zrok 외부 노출 | 미구현 | Ingress + zrok reserved share 방식 결정 |

---

## 5. 회의용 결론

오늘 작업으로 “생성만 되는 도구”에서 “실제 클러스터 상태를 보고 배포 실패를 사전에 줄이는 도구” 방향으로 진전했다.

핵심 시연 포인트:

- VM에서 직접 얻은 클러스터 리소스가 Guardrail 차단 조건에 반영된다.
- Argo CD 상태를 Grad-Deploy 화면에서 확인할 수 있다.
- GHCR private 이미지와 DB 공식 이미지 문제를 구분해 해결 방향을 코드에 반영했다.
- 다음 검증은 실제 GitHub repo push 후 Actions/GHCR/Argo CD sync 전체 루프를 한 번에 성공시키는 것이다.
