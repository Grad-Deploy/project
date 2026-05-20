# Grad-Deploy 구현 로드맵 및 2026-05-20 작업 반영

작성일: 2026-05-20  
현재 기준: 로컬 워크스페이스 구현 + 실제 VM `leeon@127.0.0.1:2222` 검증 결과 반영

---

## 1. 현재 구현 상태 요약

현재 버전은 졸업작품 MVP 기준으로 약 70% 수준까지 올라왔다.

- 파일 생성형 MVP: 약 75%
- GitOps 자동 배포 흐름: 약 65%
- 클러스터 리소스 기반 추천/차단: 약 70%
- 실제 VM/minikube 검증: 약 60%
- Argo CD 운영 가시성: 약 55%
- 멀티유저/RBAC 운영 구조: 약 45%
- 외부 URL 노출/zrok: 약 20%

현재 가능한 것:

- 서비스 추가/수정 UI
- K8s Manifest, GitHub Actions, Argo CD YAML 생성
- GitHub repo push
- ConfigMap/Secret example 생성
- kind/minikube용 설정 파일 생성
- Cluster Advisor 화면 및 VM 스크립트 결과 파싱
- CA 결과를 RA Guardrail 배포 차단 조건에 반영
- GHCR private image pull secret setup script 생성
- `kustomization.yaml` 이미지 `newTag` 기반 갱신
- DB 서비스 공식 이미지 사용
- Argo CD Application 상태 조회 UI
- 실제 VM SSH 접속 및 minikube/Argo CD 상태 확인

아직 “완성”이라고 보기 어려운 것:

- 실제 GitHub Actions → GHCR → Argo CD sync → Pod Ready 전체 루프의 반복 검증
- 브라우저에서 Argo CD API 호출 시 CORS/tunnel 환경 의존성
- Pod 상세 상태, 이벤트, 실패 원인까지 Grad-Deploy 화면에 표시하는 기능
- metrics-server 미설치 환경에서 HPA 검증 자동화
- zrok 외부 주소 노출
- 멀티유저/RBAC 구조의 최종 운영 UX 연결

---

## 2. 2026-05-20 완료 작업

### P0. 배포 루프 안정화

완료:

1. GitHub push 단일 커밋화
   - GitHub Contents API 파일별 PUT 흐름을 Git Data API 기반 tree/blob/commit/ref update 흐름으로 변경했다.
   - 여러 파일이 한 번의 커밋으로 올라가므로 Actions가 중간 상태의 매니페스트를 잡을 위험이 줄었다.

2. `kustomization.yaml` 이미지 태그 안정화
   - overlay `images` 항목에 `newName`과 `newTag: latest`를 함께 생성한다.
   - CI는 `newTag:` 존재 여부를 먼저 검사하고, 없으면 실패하도록 바뀌었다.
   - DB 서비스는 이미지 패치 대상에서 제외한다.

3. DB 공식 이미지 고정
   - MySQL, PostgreSQL, Redis, MongoDB, Elasticsearch는 더미 앱 이미지 대신 공식 이미지를 사용한다.
   - VM에서 확인된 `mysql-service-v2:latest` pull 실패 계열 문제를 줄인다.

4. GHCR private imagePullSecret 처리
   - GHCR 사용 시 앱 Deployment에 `imagePullSecrets: ghcr-pull-secret`을 넣는다.
   - `k8s/projects/<proj>/docs/setup-image-pull-secret.sh`를 생성해 VM에서 Secret을 만들 수 있게 했다.
   - 평문 `kind: Secret` YAML은 생성하지 않는다.

남은 일:

- 실제 레포에 push 후 Actions/GHCR/Argo CD sync까지 엔드투엔드 재실행
- GHCR package public/private 선택 가이드 UI 보강
- Argo CD sync 대상 이름이 ApplicationSet 방식과 단일 Application 방식에서 일관되는지 재검증

---

## 3. 클러스터 리소스 기반 추천/차단

완료:

1. Cluster Advisor 탭 재연결
   - 상단 탭에 `클러스터`를 다시 노출했다.
   - VM 스크립트 출력 파싱 결과를 화면에서 확인할 수 있다.

2. VM ARM64 Allocatable 파싱 개선
   - 기존 `grep -A5 "Allocatable:"`는 ARM64/minikube에서 `memory:` 라인을 놓칠 수 있었다.
   - `awk`로 Allocatable 블록 전체를 가져오도록 바꿨다.

3. CA → RA Guardrail 연결
   - `clusterCapacity`를 store에 저장한다.
   - RA가 서비스 request 총합과 클러스터 가용 CPU/Memory를 비교한다.
   - 추가 규칙:
     - `RA-CA-00`: CA 자체 오류 감지
     - `RA-CA-01`: CPU request 총합이 가용 CPU 초과
     - `RA-CA-02`: Memory request 총합이 가용 Memory 초과

남은 일:

- JVM/DB 서비스의 운영 여유분 임계치 강화
- 단일 노드 minikube와 멀티노드 운영 클러스터의 계산 기준을 UI에 명확히 표시
- ResourceQuota 기반 RA 검사 고도화

---

## 4. Argo CD 운영 UX

완료:

1. Argo CD 상태 카드 노출
   - 배포 탭 상단에 `Argo CD 상태` 카드를 항상 보이게 했다.
   - GitHub 인증 전에도 서버 URL, 토큰/admin 비밀번호 입력, 새로고침 버튼을 볼 수 있다.

2. Application 상태 조회
   - `GET /api/v1/applications`를 호출한다.
   - `sync.status`, `health.status`, revision, condition message를 표시한다.
   - `<proj>-project`, `<proj>-*`, `<proj>` 기준으로 필터링하되, 매칭이 없으면 조회 가능한 앱을 보여준다.

VM에서 확인한 사실:

- Argo CD API `/api/v1/applications`는 port-forward 환경에서 정상 응답했다.
- 기존 `demo-app`은 `Synced / Degraded` 상태였다.
- 실패 원인은 앱 자체보다는 이미지 pull 권한, CPU 부족, metrics-server 부재 쪽으로 확인됐다.

남은 일:

- 브라우저 CORS 우회용 프록시 또는 백엔드 API 경유 방식 결정
- Pod/Event 조회 카드 추가
- `ImagePullBackOff`, `Pending`, `CrashLoopBackOff`, `OOMKilled` 원인 메시지 매핑
- 배포 진행 단계 카드 추가: push, Actions, image build, sync, Pod Ready, external URL

---

## 5. 실제 VM 검증에서 확인된 리스크

VM 정보:

- 접속: `ssh -p 2222 leeon@127.0.0.1`
- OS: Ubuntu 24.04 ARM64
- 클러스터: minikube docker driver
- Argo CD: `argocd` namespace에서 동작 확인

확인된 이슈:

1. `mysql-svc-0` ImagePullBackOff
   - 기존 매니페스트가 `ghcr.io/leeon3345/mysql-service-v2:latest`를 바라보고 있었다.
   - 이번 작업으로 DB 공식 이미지 사용 및 GHCR pull secret setup script 생성을 반영했다.

2. `spring-svc` Pending
   - Kubernetes event에서 `Insufficient cpu` 확인.
   - CA → RA 차단 규칙이 실제로 필요한 이유가 검증됐다.

3. HPA metric 조회 실패
   - `pods.metrics.k8s.io`가 없어 metrics-server 미설치 상태로 확인.
   - HPA 사용 전 metrics-server 설치 안내 또는 자동 검사 필요.

---

## 6. 다음 우선순위

### P0. End-to-End 배포 재검증

- 실제 GitHub repo에 현재 생성물을 push
- GitHub Actions 성공 여부 확인
- GHCR image push 확인
- VM에서 `setup-image-pull-secret.sh` 실행
- Argo CD sync 후 Pod Ready 확인

### P1. Argo CD 상태 고도화

- Pod 상태 및 Event 조회 추가
- 실패 원인별 해결 가이드 표시
- CORS/tunnel 문제를 피하기 위한 API proxy 결정

### P2. zrok 외부 노출

- MVP 방식 결정:
  - Ingress Controller 1개
  - zrok reserved share 1개
  - `/사용자/서비스` path routing

예:

```text
https://grad-demo.share.zrok.io/leeon/spring
https://grad-demo.share.zrok.io/leeon/react
```

### P3. 멀티유저/RBAC 정리

- App of Apps vs ApplicationSet 최종 결정
- 사용자별 AppProject/Namespace/Application 명명 규칙 확정
- GitHub SSO/RBAC 실제 로그인 검증

### P4. Guardrail 명세 확장

- VE-01 Deprecated API 검사
- VE-02 selector matchLabels mismatch 검사
- VE-04 imagePullSecrets 누락 검사
- NA-02 Ingress TLS 누락 검사
- NA-03 Ingress serviceName mismatch 검사
- PG-05 probe periodSeconds 과도 검사
- GE-05 finalizer stuck 검사
- RA-04/05 ResourceQuota 기반 검사 정교화
