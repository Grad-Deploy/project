# Grad-Deploy 구현 우선순위 및 회의 정리

작성일: 2026-05-20 회의 준비용  
현재 기준: 조원 최신 원격 코드 `f8d7b18` 기반 + CA 클러스터 진단 화면 재연결

---

## 1. 현재 구현 상태 요약

현재 버전은 전체 졸업작품 목표 기준으로 약 55% 정도 구현된 상태로 본다.

- 파일 생성형 MVP: 약 65%
- GitOps 자동 배포 흐름: 약 50%
- 멀티유저/RBAC 운영 구조: 약 40%
- 클러스터 리소스 기반 추천/차단: 약 35%
- 실제 운영 안정성: 약 35%

현재 가능한 것:

- 서비스 추가/수정 UI
- K8s Manifest, GitHub Actions, Argo CD YAML 생성
- GitHub repo push
- ConfigMap/Secret용 환경변수 UI
- 기본 Guardrail 검사 일부
- kind/minikube용 설정 파일 생성 일부
- Argo CD 자동 연동 시도
- GitHub SSO/RBAC YAML 생성
- ApplicationSet/AppProject 생성 로직 일부
- CA 클러스터 진단 화면
- VM 스크립트 결과 파싱
- 브라우저 리소스 감지
- Demo/Credit 패널 시뮬레이션

아직 “완성”이라고 보기 어려운 것:

- 실제 배포가 항상 끝까지 성공하는 상태는 아님
- 멀티유저 구조는 코드가 있지만 메인 흐름에 완전히 연결되지 않음
- CA 결과가 RA 계산에 실제 반영되지 않음
- zrok 외부 주소 노출 기능 없음
- Argo CD 상태를 사용자 화면에서 직접 조회하지 못함
- Secret/GHCR/imagePullSecret 흐름이 아직 불안정함

---

## 2. 구현 안 된 기능 우선순위

### P0. 실제 배포 루프 안정화

졸업작품 시연에서 가장 먼저 성공해야 하는 흐름이다.

목표:

```text
Grad-Deploy 설정
→ GitHub repo에 파일 push
→ GitHub Actions 이미지 빌드
→ GHCR push
→ 이미지 태그 갱신
→ Argo CD sync
→ minikube/k8s 클러스터 배포
→ 서비스 접속 확인
```

해야 할 일:

1. GitHub Push 단일 커밋화
   - 현재는 GitHub Contents API로 파일별 PUT을 수행한다.
   - 여러 커밋이 연속으로 생기면 GitHub Actions가 중간 상태에서 실행될 수 있다.
   - Git Data API 기반으로 tree/blob/commit을 생성해 한 번에 push해야 한다.

2. `kustomization.yaml` 이미지 태그 안정화
   - 현재 Actions는 `newTag:`를 sed로 바꾸려 하지만, 생성되는 kustomization에 `newTag`가 없을 수 있다.
   - 생성 시점부터 `newTag: latest` 또는 초기 sha를 넣어야 한다.

3. GHCR private imagePullSecret 처리
   - private GHCR 이미지에서는 `ImagePullBackOff: unauthorized`가 발생한다.
   - MVP 선택지:
     - GHCR package public 안내
     - namespace별 `imagePullSecret` 생성 명령 제공
     - ServiceAccount patch 자동 생성

4. replicas ignore 설정 재검토
   - Argo CD `ignoreDifferences`에서 `/spec/replicas`를 무시하면 UI에서 replicas 변경해도 반영이 안 될 수 있다.
   - HPA 사용 시에만 ignore 하도록 조건화하거나 기본 제거가 필요하다.

---

### P1. 클러스터 리소스 기반 추천 연결

현재 CA 화면은 붙었지만, RA 계산에는 아직 직접 연결되지 않았다.

해야 할 일:

1. CA 결과를 전역 상태에 저장
   - 예: `state.clusterCapacity`
   - 값:
     - `availableCPU`
     - `availableMem`
     - `env`
     - `workloadNodeCount`
     - `hasError`

2. RA가 CA 결과를 사용하도록 수정
   - 서비스 request 총합이 CA 가용 리소스를 넘으면 ERROR
   - replicas 반영한 총량 계산
   - DB/JVM 서비스가 있으면 memory threshold 강화

3. 배포 버튼 차단 조건에 CA 오류 포함
   - CA ERROR 또는 RA ERROR가 있으면 배포 비활성화
   - 예: 워커 없음, 메모리 0Mi, request 총합 초과

4. minikube 단일 노드 기준 정리
   - 단일 노드 minikube는 control-plane도 파드 배치 대상으로 계산한다.
   - 멀티노드 운영 클러스터에서는 worker 중심으로 계산한다.

---

### P2. 사용자 상태 조회 및 운영 UX

사용자는 Argo CD UI를 직접 보지 않아도 Grad-Deploy에서 상태를 확인해야 한다.

해야 할 일:

1. Argo CD Application 상태 조회
   - `Synced`, `OutOfSync`, `Unknown`
   - `Healthy`, `Progressing`, `Degraded`

2. Pod 상태 조회
   - `Running`
   - `Pending`
   - `CrashLoopBackOff`
   - `ImagePullBackOff`
   - `OOMKilled`

3. 실패 원인 메시지 매핑
   - `ImagePullBackOff`: GHCR 권한 또는 imagePullSecret 문제
   - `Pending`: CPU/Memory/PVC 부족
   - `CrashLoopBackOff`: 앱 실행 실패 또는 env 누락
   - `Unknown`: Argo CD repo auth 또는 path 문제

4. 배포 진행 카드
   - GitHub push 완료
   - Actions 실행 중
   - 이미지 빌드 완료
   - Argo CD sync 완료
   - Pod Ready
   - 외부 URL 준비

---

### P3. 멀티유저 / RBAC 구조 정리

현재 코드에는 멀티유저 관련 파일이 있지만 메인 앱에는 완전히 연결되어 있지 않다.

해야 할 일:

1. App of Apps 또는 ApplicationSet 중 최종 방향 결정
   - 현재는 둘 다 흔적이 있다.
   - 회의에서 하나를 정해야 한다.

2. 사용자별 명명 규칙 확정
   - GitHub user/team
   - AppProject
   - Namespace
   - Application
   - GitOps path

예:

```text
user: leeon3345
project: grad-leeon3345
namespace: grad-leeon3345
application: leeon3345-demo-app
path: apps/leeon3345/demo-app
```

3. GitHub SSO/RBAC 검증
   - GitHub 로그인 후 본인 AppProject만 보이는지 확인
   - 다른 사용자 Application sync/rollback이 막히는지 확인

4. MultiUserPanel 연결 여부 결정
   - 관리자용 화면으로 붙일지
   - 별도 운영자 도구로 뺄지

---

### P4. 외부 주소 노출

현재 zrok 외부 주소 기능은 구현되어 있지 않다.

해야 할 일:

1. MVP 방식 결정
   - 서비스별 zrok reserved share
   - 또는 Ingress 하나 + zrok 하나 + path routing

2. 추천 MVP

```text
Ingress Controller 1개
→ zrok reserved share 1개
→ /사용자/서비스 path 기반 라우팅
```

예:

```text
https://grad-demo.share.zrok.io/leeon/spring
https://grad-demo.share.zrok.io/leeon/react
```

3. watchdog 스크립트 생성
   - port-forward 또는 zrok 프로세스가 죽으면 자동 재시작
   - systemd 등록 가이드 제공

---

### P5. Secret / ConfigMap / 보안 정책 정리

해야 할 일:

1. `secret.example.yaml`과 실제 `secret.yaml` 참조 충돌 정리
   - Git에는 example만 올릴지
   - 실제 Secret은 클러스터에 직접 만들지
   - SealedSecret을 쓸지 결정

2. `.gitignore` 보강
   - `secret.yaml`
   - `*-secret.yaml`
   - `.env`
   - `.env.*`

3. Namespace 기본 보안 정책 생성
   - ResourceQuota
   - LimitRange
   - NetworkPolicy default-deny
   - Pod Security restricted

---

### P6. Guardrail 명세 보강

아직 보고서 명세 전체를 커버하지 못한다.

추가 구현 후보:

- VE-01 Deprecated API 검사
- VE-02 selector matchLabels mismatch 검사
- VE-04 imagePullSecrets 누락 검사
- NA-02 Ingress TLS 누락 검사
- NA-03 Ingress serviceName mismatch 검사
- PG-05 probe periodSeconds 과도하게 짧은 경우 검사
- GE-05 finalizer stuck 검사
- RA-04/05 ResourceQuota 기반 검사 정교화

---

## 3. 테스트용 서비스 추가 계획

실제 배포 테스트를 위해 프론트엔드 + 백엔드 + DB 조합이 필요하다.

### 테스트 서비스 구성

```text
frontend:
  type: nginx 또는 react-nginx
  port: 80
  expose: true
  path: /

backend:
  type: spring-boot 또는 node-backend
  port: 8080
  expose: false
  dependsOn: db

database:
  type: mysql 또는 postgresql
  port: 3306
  expose: false
  pvc: true
```

### 최소 리소스 권장값

minikube 단일 노드 기준:

```text
frontend:
  request: 64m / 128Mi
  limit: 250m / 256Mi

backend:
  request: 250m / 512Mi
  limit: 500m / 1Gi

database:
  request: 250m / 512Mi
  limit: 500m / 1Gi
```

### 테스트 앱 요구사항

백엔드는 다음 API를 제공하면 된다.

```text
GET /health
→ 200 OK

GET /api/message
→ DB에서 message 조회 후 반환

POST /api/message
→ DB에 message 저장
```

프론트엔드는 다음 기능만 있으면 된다.

```text
1. 백엔드 health 상태 표시
2. message 조회
3. message 저장
4. 현재 배포 이미지 태그 또는 버전 표시
```

DB는 다음 테이블 하나면 충분하다.

```sql
CREATE TABLE messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  content VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 4. 검증 시나리오

### 시나리오 A. 최초 배포

```text
1. Grad-Deploy에서 프로젝트 생성
2. frontend + backend + db 서비스 추가
3. CA 분석 실행
4. RA/Guardrail 통과 확인
5. GitHub repo에 파일 push
6. GitHub Actions 실행 확인
7. GHCR 이미지 push 확인
8. Argo CD Application 생성 확인
9. Pod Running 확인
10. 외부 주소 또는 port-forward로 frontend 접속
11. frontend → backend → db 호출 확인
```

성공 기준:

```text
frontend 접속 가능
backend /health 200
DB write/read 가능
Argo CD Synced + Healthy
```

### 시나리오 B. 코드 수정

```text
1. backend 응답 메시지 수정
2. git add .
3. git commit -m "fix: update message"
4. git push origin main
5. Actions 이미지 빌드
6. image tag 변경
7. Argo CD rolling update
8. frontend에서 변경된 응답 확인
```

성공 기준:

```text
새 이미지 태그로 Pod 교체
서비스 중단 없이 응답 변경 확인
```

### 시나리오 C. 설정 수정

```text
1. Grad-Deploy에서 backend replicas 1 → 2
2. manifest 재생성
3. GitHub push
4. Argo CD sync
5. Deployment replicas 2 확인
```

성공 기준:

```text
이미지 재빌드 없이 replicas만 변경
Pod 2개 Running
```

### 시나리오 D. 리소스 초과 차단

```text
1. backend memory request를 과도하게 설정
2. CA/RA 결과 확인
3. 배포 버튼 비활성화 또는 ERROR 표시 확인
```

성공 기준:

```text
가용 메모리 초과 시 배포 차단
권장 수정값 표시
```

### 시나리오 E. 실패 원인 진단

테스트할 실패:

```text
GHCR private image → ImagePullBackOff
request 과다 → Pending
env 누락 → CrashLoopBackOff
repo auth 실패 → Argo CD Unknown
```

성공 기준:

```text
Grad-Deploy가 원인을 사람이 이해 가능한 문구로 표시
```

---

## 5. 오늘 내가 할 수 있는 일

오늘은 큰 구조 변경보다 “내일 회의 때 보여줄 근거”를 만드는 게 좋다.

### 1순위. 현재 버전 실행 확인

```bash
cd /Users/leeon/Documents/graddeploy
npm run dev -- --host 0.0.0.0
```

확인:

```text
서비스 탭 정상 표시
클러스터 탭 정상 표시
배포 탭 정상 표시
YAML preview 정상 표시
```

### 2순위. CA 테스트 캡처

테스트할 입력:

```text
로컬 PC:
Chrome에서 CPU/RAM 감지 문구 확인

VM:
마스터 노드에서 kubectl describe nodes 결과 붙여넣기

단일 노드:
control-plane 1개만 입력했을 때 파드 배치 대상으로 계산되는지 확인
```

회의에 가져갈 캡처:

```text
1. 로컬 감지 화면
2. VM 파싱 완료 화면
3. CA 분석 결과 화면
4. RA 입력값 표시 화면
```

### 3순위. 관리자 클러스터 상태 확인

VM에서:

```bash
minikube status
kubectl get nodes -o wide
kubectl get pods -n argocd
kubectl get applications -n argocd
kubectl get applicationsets -n argocd
```

확인할 것:

```text
Argo CD 정상 실행
ApplicationSet CRD 존재 여부
현재 클러스터 CPU/Memory 여유
```

### 4순위. 테스트 앱 방향 결정

오늘은 구현까지 못 해도 다음 중 하나를 정하면 좋다.

선택지:

```text
A. 아주 작은 Node.js + React + MySQL 테스트 앱
B. Spring Boot + React/Nginx + MySQL 테스트 앱
C. 기존 서비스 이미지를 사용한 배포 테스트
```

추천:

```text
MVP 검증은 Node.js + React + MySQL이 가볍다.
졸업작품 설명은 Spring Boot 예시도 같이 지원하면 좋다.
```

### 5순위. 회의 안건 정리

내일 반드시 결정할 것:

```text
1. App of Apps로 갈지 ApplicationSet으로 갈지
2. minikube 유지할지 k3s/kubeadm으로 바꿀지
3. 중앙 GitOps Repo를 둘지 사용자 repo를 직접 볼지
4. GHCR private 문제를 public 안내로 갈지 imagePullSecret 자동화로 갈지
5. zrok 외부 노출을 MVP 범위에 넣을지
```

---

## 6. minikube 그대로 갈지, k8s로 바꿀지

여기서 “k8s로 바꾼다”는 의미를 명확히 나눠야 한다.

### 선택지 1. minikube 유지

장점:

- 설치가 쉽다.
- 단일 VM에서 빠르게 데모 가능하다.
- 발표용 재현성이 좋다.
- 개발자가 로컬에서 같은 환경을 만들기 쉽다.

단점:

- 단일 노드라 실제 운영형 멀티테넌시 설명에 한계가 있다.
- 사용자별 노드 격리 테스트가 어렵다.
- 여러 서비스가 올라가면 리소스 부족이 빨리 온다.

추천 용도:

```text
1학기 MVP
중간/기말 발표 데모
개발자 로컬 테스트
```

### 선택지 2. k3s

장점:

- 가볍다.
- VM 한 대 또는 여러 대에서 운영형에 가깝게 테스트할 수 있다.
- minikube보다 서버형 운영 느낌이 강하다.
- 졸업작품 2학기 확장에 적합하다.

단점:

- minikube보다 초기 설정과 디버깅이 조금 더 필요하다.
- 팀원이 같은 환경을 재현하려면 문서화가 필요하다.

추천 용도:

```text
2학기 확장
관리자 클러스터 장기 실행
여러 사용자 namespace 테스트
```

### 선택지 3. kubeadm 기반 Kubernetes

장점:

- 가장 표준적인 Kubernetes 설치 방식이다.
- control-plane/worker 분리, 노드 추가, taint/toleration 테스트가 가능하다.
- 운영형 설명에 가장 좋다.

단점:

- 설치/운영 난이도가 높다.
- 네트워크 플러그인, 인증서, 업그레이드 등 관리 포인트가 많다.
- 졸업작품 기능 구현보다 인프라 삽질이 커질 수 있다.

추천 용도:

```text
2학기 후반 또는 최종 고도화
노드 격리/멀티노드 검증
```

### 선택지 4. EKS 같은 Managed Kubernetes

장점:

- 실제 클라우드 운영 환경과 가장 유사하다.
- LoadBalancer, Ingress, IAM, Registry 연동 검증에 좋다.

단점:

- 비용 발생.
- EKS control plane 자체가 무료가 아니다.
- 졸업작품 개발 단계에서는 비용/운영 부담이 크다.

추천 용도:

```text
선택 기능 또는 Phase 2
최종 보고서의 클라우드 확장 검증
짧은 시간만 켜서 테스트
```

### 현재 추천 결론

```text
1학기/현재:
minikube 유지

2학기 초:
k3s 관리자 클러스터 검토

2학기 후반:
필요하면 kubeadm 멀티노드 또는 EKS 단기 검증
```

이유:

- 지금은 GitOps 배포 루프와 Grad-Deploy 기능 완성이 더 중요하다.
- 인프라를 너무 빨리 키우면 기능 구현 시간이 줄어든다.
- minikube에서 기능을 안정화한 뒤 k3s로 옮기는 게 현실적이다.

---

## 7. 회의에서 제안할 최종 방향

### MVP 목표

```text
관리자 클러스터 1개
minikube 또는 k3s
Argo CD 설치
사용자별 namespace
Grad-Deploy UI로 서비스 설정
GitHub Actions + GHCR + Argo CD 자동 배포
CA/RA로 리소스 초과 차단
```

### 2학기 확장 목표

```text
관리자 클러스터 k3s 또는 kubeadm 전환
App of Apps/ApplicationSet 정식화
GitHub SSO/RBAC 검증
zrok 또는 Ingress 외부 주소 제공
Argo CD 상태 대시보드
SealedSecret 또는 ExternalSecret 도입
사용자별 quota/NetworkPolicy/Pod Security 기본 적용
```

### 회의 결정 필요 항목

```text
1. App of Apps vs ApplicationSet
2. minikube 유지 vs k3s 전환 시점
3. 테스트 앱 스택: React + Node.js + MySQL vs React + Spring Boot + MySQL
4. GHCR private 처리 방식
5. zrok을 MVP 범위에 넣을지
6. 멀티유저 기능을 이번 학기 범위에 넣을지
```

---

## 8. 역할 분담 반영안

이전 회의에서 논의한 역할 분담을 현재 구현 우선순위에 맞춰 정리한다.

### 역할 1. 플랫폼/GitOps 담당

담당 범위:

```text
ApplicationSet 구조 설계
중앙 GitOps Repo 디렉터리 구조 정의
사용자별 AppProject/Application YAML 생성
Argo CD syncPolicy, prune, selfHeal 설정
배포 상태 확인 명령/문서화
```

현재 코드와 연결되는 파일:

```text
src/generators/k8s_improved.js
src/generators/multiUser.js
src/components/DeployPanel.jsx
server/index.js
```

이번 주 우선 작업:

```text
1. App of Apps와 ApplicationSet 중 최종 구조 결정
2. 중앙 GitOps Repo 디렉터리 규칙 확정
3. 사용자별 AppProject/ApplicationSet YAML 생성 결과 검증
4. Argo CD에 실제 apply해서 Application 자동 생성 확인
5. 배포 확인 명령어 문서화
```

산출물:

```text
gitops-repo 디렉터리 구조 예시
AppProject YAML
ApplicationSet 또는 root Application YAML
최초 부트스트랩 순서 문서
배포 상태 확인 명령어 목록
```

완료 기준:

```text
특정 사용자 폴더를 GitOps repo에 추가하면
Argo CD가 해당 사용자 Application을 자동 생성하고
Synced/Healthy 상태까지 도달해야 한다.
```

---

### 역할 2. 인증/RBAC 담당

담당 범위:

```text
GitHub SSO 연동 조사/설정
GitHub 팀/ID와 Argo CD Role 매핑
AppProject Role 정책 작성
사용자별 접근 권한 테스트
admin 계정 사용 범위 정리
```

현재 코드와 연결되는 파일:

```text
src/generators/k8s_improved.js
src/components/DeployPanel.jsx
src/utils/argoAutoSetup.js
```

이번 주 우선 작업:

```text
1. GitHub OAuth App 생성 절차 정리
2. Argo CD dex.config 설정 검증
3. argocd-rbac-cm policy.csv 규칙 검증
4. GitHub user/team → Argo CD role 매핑 규칙 확정
5. admin 계정 사용 범위 문서화
```

산출물:

```text
GitHub SSO 설정 가이드
argocd-cm.yaml
argocd-rbac-cm.yaml
권한 매핑표
접근 제어 테스트 결과
```

완료 기준:

```text
사용자 A가 로그인했을 때 A 프로젝트만 조회/Sync 가능하고,
사용자 B 프로젝트는 조회 또는 조작할 수 없어야 한다.
admin 계정은 초기 설정/장애 대응 용도로만 정의되어야 한다.
```

주의:

```text
admin 계정 공유는 실제 사용자 접근 방식으로 사용하지 않는다.
사용자 접근은 GitHub SSO + Argo CD RBAC로 분리한다.
```

---

### 역할 3. 외부 접속/zrok 담당

담당 범위:

```text
zrok reserved share 구조 설계
Argo CD 또는 사용자 서비스 외부 노출 방식 결정
port-forward + zrok watchdog 스크립트 작성
systemd 서비스 등록 방식 작성
README에 접속 URL 자동/수동 반영 방식 정리
```

현재 코드와 연결되는 파일:

```text
src/generators/k8s_improved.js
README.md
추가 예정: scripts/zrok-watchdog.sh
추가 예정: scripts/grad-deploy-tunnel.service
```

이번 주 우선 작업:

```text
1. zrok reserved share 방식 테스트
2. VM 재시작 후 같은 URL로 복구되는지 확인
3. 서비스별 zrok vs Ingress 단일 zrok gateway 방식 비교
4. port-forward/zrok 프로세스 watchdog 스크립트 작성
5. systemd 등록 가이드 작성
```

산출물:

```text
zrok reserve/share 명령어
watchdog script
systemd unit 예시
외부 접속 README 문구
접속 URL 표시 정책
```

완료 기준:

```text
터널 프로세스가 죽어도 watchdog 또는 systemd로 재시작되고,
reserved share URL은 동일하게 유지되어야 한다.
```

권장 방향:

```text
MVP:
서비스별 reserved share 또는 Ingress 1개 + zrok 1개 중 빠른 방식 선택

확장:
Ingress 1개 + zrok reserved share 1개 + path routing
```

---

### 역할 4. 보안/가드레일/검증 담당

담당 범위:

```text
ResourceQuota/LimitRange/NetworkPolicy 정책 정리
AppProject로 막을 수 없는 항목 리스트업
보안 테스트 시나리오 작성
타 사용자 프로젝트 접근 차단 검증
리소스 초과/OOM/Pending 테스트
```

현재 코드와 연결되는 파일:

```text
src/engines/guardrail.js
src/engines/ca.js
src/components/ClusterAdvisorPanel.jsx
src/generators/k8s_improved.js
```

이번 주 우선 작업:

```text
1. ResourceQuota/LimitRange 기본값 확정
2. default-deny NetworkPolicy 적용 방식 검증
3. CA availableCPU/availableMem을 RA에 연결할 정책 정의
4. 리소스 초과 시 배포 차단 조건 정리
5. 실패 시나리오 테스트 표 작성
```

산출물:

```text
namespace 기본 정책 YAML
CA/RA 연동 정책
Guardrail 미구현 룰 리스트
보안 테스트 체크리스트
OOM/Pending/ImagePullBackOff 테스트 결과표
```

완료 기준:

```text
사용자 서비스 request 합산이 클러스터 가용량을 넘으면 배포 전 ERROR가 발생해야 한다.
타 사용자 namespace 접근은 NetworkPolicy/RBAC로 차단되어야 한다.
메모리 초과, CPU 부족, 이미지 인증 실패를 재현하고 원인을 문서화해야 한다.
```

---

## 9. 역할별 의존 관계

작업 순서는 다음과 같다.

```text
1. 플랫폼/GitOps 담당
   → GitOps repo 구조, ApplicationSet/AppProject 기본 흐름 확정

2. 인증/RBAC 담당
   → AppProject 이름 규칙을 받아 GitHub SSO/RBAC 매핑

3. 보안/가드레일/검증 담당
   → namespace 정책, quota, network policy를 GitOps 구조에 삽입

4. 외부 접속/zrok 담당
   → 배포된 서비스 또는 Ingress를 외부 URL로 노출
```

서로 먼저 합의해야 하는 공통 규칙:

```text
사용자 ID 규칙
프로젝트명 규칙
namespace 이름 규칙
AppProject 이름 규칙
Application 이름 규칙
GitOps repo path 규칙
외부 URL path 규칙
```

권장 명명 규칙:

```text
GitHub user/team: leeon3345
Project: grad-leeon3345-demo
Namespace: grad-leeon3345-demo
AppProject: project-leeon3345-demo
Application: app-leeon3345-demo
GitOps path: apps/leeon3345/demo
External URL path: /leeon3345/demo
```

---

## 10. 내일 회의용 역할별 질문

### 플랫폼/GitOps 담당에게

```text
ApplicationSet으로 갈 것인지 App of Apps로 갈 것인지
중앙 GitOps Repo를 둘 것인지 사용자 repo를 직접 볼 것인지
GitHub Push를 단일 커밋으로 바꾸는 작업을 누가 맡을 것인지
```

### 인증/RBAC 담당에게

```text
GitHub SSO를 이번 학기 범위에 넣을 것인지
GitHub team 기반으로 할지 user ID 기반으로 할지
admin 계정 토큰 유효기간/관리 정책을 어떻게 둘 것인지
```

### 외부 접속/zrok 담당에게

```text
zrok을 MVP에 포함할 것인지
서비스별 URL로 갈지 Ingress path routing으로 갈지
VM 재시작/터널 끊김 복구를 어떻게 처리할지
```

### 보안/가드레일/검증 담당에게

```text
ResourceQuota 기본값을 얼마로 할지
CA 결과를 RA에 어떤 기준으로 연결할지
OOM/Pending/ImagePullBackOff를 어떤 테스트로 재현할지
AppProject로 막을 수 없는 위험을 어떻게 보완할지
```
