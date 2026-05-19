# Grad-Deploy v2 작업 검증 및 내일 회의 대비 보고서

- **작업 일자**: 2026-05-20
- **프로젝트 명**: Grad-Deploy v2 (GitOps Guardrail Platform)
- **작업 브랜치**: `feat/mvp-validation-and-ca-integration`
- **작업 및 테스트 환경**: 로컬 개발 서버 및 실제 대상 VM (`leeon@127.0.0.1:2222`, Ubuntu ARM64, minikube)

---

## 1. 오늘 구현 및 완료된 작업 (Completed Tasks)

기존 코드 안정성을 유지하며 실질적 MVP 가치 증명을 위한 핵심 연동 로직 구현 및 안정화 작업에 집중.

### ① CA(Cluster Advisor) ➔ RA(Guardrail) 연동 흐름 구축
- **작업 내용**: 클러스터 상태 감지 결과를 리소스 제한 권장 및 배포 통제 로직에 반영하도록 통합.
- **수정 파일**: `src/App.jsx`, `src/components/ClusterAdvisorPanel.jsx`, `src/hooks/useStore_improved.js`, `src/engines/guardrail.js`
- **상세 사항**:
  - `ClusterAdvisorPanel` 계산 결과(`availableCPU`, `availableMem`, `workloadNodeCount`, `hasError`)를 상위 `App`으로 콜백하여 store의 `clusterCapacity` 상태 업데이트 수행.
  - Guardrail 엔진 내 실질적인 배포 차단 규칙 2종 추가:
    - **`RA-CA-01` (ERROR)**: 서비스 CPU `request` 합계가 Cluster Advisor 가용 CPU 초과 시 배포 차단.
    - **`RA-CA-02` (ERROR)**: 서비스 Memory `request` 합계가 Cluster Advisor 가용 Memory 초과 시 배포 차단.
    - **`RA-CA-00` (ERROR)**: CA 자체 에러 감지 시 비정상 배포 사전 차단.

### ② Kubernetes Manifest 생성기 안정화 (`k8s_improved.js`)
- **작업 내용**: 컨테이너 이미지 주소 불완전성 및 버그 유발 요소 제거.
- **수정 파일**: `src/generators/k8s_improved.js`
- **상세 사항**:
  - **레지스트리 헬퍼 도입**: GHCR (`ghcr.io`), Docker Hub (`docker.io`), 로컬 레지스트리 (`localhost:5001`) 주소 표준 규격 변환 로직 보완.
  - **DB 공식 이미지 고정**: 데이터베이스 서비스 생성 시 더미 이미지 대신 도커 공식 이미지(`mysql:8.0` 등) 할당 강제화.
  - **Kustomize 이미지 갱신 제어**: CI 파이프라인 이미지 변경 시 `newTag` 존재 여부 검증 및 불완전 상태의 오작동 방지.

### ③ GitHub Push 흐름 최적화 (Single-Commit Flow)
- **작업 내용**: 파일 개수별 개별 API 호출(PUT)로 인한 기존 업로드 방식의 불안정성 개선.
- **수정 파일**: `src/components/DeployPanel.jsx`
- **상세 사항**:
  - Git Data API(Blob ➔ Tree ➔ Commit ➔ Ref Update) 기반 일괄 푸시 흐름 구현.
  - 다량의 매니페스트 파일 전송 시에도 단일 커밋(`chore: grad-deploy update <N> files`)으로 원자적(Atomic) 처리.
  - 기존 파일별 상태 표시 UI와의 호환성 유지를 위한 결과 배열 맵 반환 예외 처리 적용.

### ④ Argo CD 상태 대시보드 최소 구현 (Status Dashboard)
- **작업 내용**: 배포 이후 실시간 진행 상태 파악을 위한 가시성 확보.
- **수정 파일**: `src/components/DeployPanel.jsx`
- **상세 사항**:
  - Argo CD API(`GET /api/v1/applications`) 활용, 프로젝트 접두사(`<proj>-`) 기준 애플리케이션 필터링 노출.
  - 배포 상태 카드 내 `sync.status`, `health.status`, 적용 커밋 short SHA, 경고 메시지 실시간 조회 및 새로고침 기능 구현.

---

## 2. 실제 VM 접속 검증 및 신규 수정 사항 (VM Live Test & Hot-Fix)

실제 VM 환경(`Ubuntu arm64 / minikube`) 직접 접속 및 구동 테스트를 통한 환경별 버그 포착 및 즉각 대응 완료.

### ① Cluster Advisor ARM64 노드 파싱 버그 핫픽스
- **문제 발생**: 기존 `grep -A5 "Allocatable:"` 방식 적용 시, arm64 아키텍처 특화 정보(`hugepages-32Mi` 등)로 인해 핵심 지표인 `memory:` 값 누락 발생.
- **해결 방안 (`ClusterAdvisorPanel.jsx` 수정)**: `awk` 활용, `Allocatable:` 블록 전체의 키-값을 동적 수집하도록 파서 개편.
- **결과**: `CPU=6, MEM=11GB` 환경 내 가용 자원 정확도 확보 (`availableCPU 6000m`, `availableMem 11929Mi` 정상 인식).

### ② VM 내 실제 Pod 기동 테스트 결과 피드백
- **DB ErrImagePull 발견**: 비공개 GHCR 접근 권한 문제로 인한 `mysql-service-v2:latest` 다운로드 실패 확인. 금일 반영한 **"DB 공식 이미지 대체 로직"**의 실효성 검증 완료.
- **spring-svc Pending 현상**: CPU 자원 부족(`Insufficient cpu`)으로 인한 스프링 Pod 대기 상태 포착. 구축 완료된 **CA ➔ RA 가드레일 통제 로직(용량 제한 규칙)의 필요성 및 기술적 타당성 확보**.

---

## 3. 미구현 사항 및 다음 개발 대상 (Remaining Tasks)

| 미구현 기능 | 문제 및 현상 | 차기 개발 방향 (Next Action) |
| :--- | :--- | :--- |
| **GHCR Private Pull Secret 연동** | 비공개 이미지 배포 시 자격 증명(PAT) 실패 현상 | K8s 내 `imagePullSecrets` 자동 생성 및 매니페스트 패치 로직 추가 |
| **Argo CD status 실제 연동 고도화** | 가상 IP 및 외부 접속 환경에 따른 타임아웃 우려 | 인클러스터 서비스 프록시 혹은 API 터널링 최적화 |
| **zrok 외부 노출 구현** | 로컬/VM 배포 앱에 대한 즉각적인 외부 도메인 접근 경로 부재 | zrok SDK 혹은 에이전트를 가이드 스크립트에 포함하여 배포 자동화 |
| **Multi-user 테넌트 완벽 연동** | 멀티유저 UI와 생성 YAML 내 네임스페이스 격리 로직 미연결 | `kustomization.yaml` 내 `namespace: <student-id>` 동적 생성 안정화 |

---

## 4. 내일 팀 미팅 의사결정 포인트 (Decision Points)

1. **K8s 엔진 존속 여부 (minikube vs k3s)**
   - 1학기 MVP 단계의 minikube 유지 여부 및 2학기 본 런칭 시 멀티노드 구성이 용이한 k3s 전환 여부 논의.
2. **중앙 공유 GitOps 레포 vs 개별 유저 전용 레포**
   - 보안 격리 및 운영 안정성을 고려한 플랫폼 전용 단일 저장소 통합 여부 결정.
3. **zrok 도입 시점 조율**
   - 외부 노출 기능(zrok)의 MVP 포함 여부 및 마일스톤 범위 설정.
4. **CA ➔ RA 최적화 담당자 선정**
   - 가드레일 차단 수치 규칙 정교화(예: 여유 오버헤드 20% 임계치 설정 등) 작업 전담 소유자 지정.
