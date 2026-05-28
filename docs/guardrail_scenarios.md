# Grad-Deploy v2.0 Guardrail 실패 시나리오 방어 가이드 (데모데이 발표용)

Grad-Deploy의 핵심 가치는 단순한 YAML 생성을 넘어, 실제 쿠버네티스 환경에서 흔히 발생하는 **인프라 구성 및 배포 실패를 코드로 사전 검증(Policy-as-Code)하여 원천 차단**하는 데 있습니다. 

본 문서에서는 데모데이 발표 시 활용할 수 있는 3가지 대표적인 실패 시나리오와 Grad-Deploy Guardrail이 이를 어떻게 방어하는지 설명합니다.

---

## 시나리오 1: 리소스 고갈로 인한 무한 Pending (Cluster Advisor 방어)

### 🚨 문제 발생 상황 (일반적인 Kubernetes 배포 시)
개발자가 MSA 환경에서 여러 개의 스프링 부트(Spring Boot) 애플리케이션과 무거운 데이터베이스를 한 번에 배포하려 합니다. 각 서비스의 CPU Request를 넉넉하게 잡고 `kubectl apply`를 실행하지만, 노드의 **실제 가용 CPU(Allocatable CPU)를 초과하여 Pod들이 끝없는 `Pending` 상태**에 빠집니다. 왜 안 켜지는지 원인을 찾기 위해 `kubectl describe pod`를 일일이 확인해야만 합니다.

### 🛡 Grad-Deploy의 방어 (RA-05 / RA-06)
- **감지 및 차단**: Grad-Deploy는 **Cluster Advisor**를 통해 타겟 클러스터(Minikube, EKS 등)의 가용 리소스를 실시간으로 읽어옵니다. 사용자가 UI에서 Replica를 늘리거나 Request를 높일 때, 전체 합산량이 가용량을 초과하면 즉시 **Error 가드레일을 발동시켜 배포 자체를 차단**합니다.
- **데모 설명**: "여러분, 비용을 아끼기 위해 작은 Minikube 클러스터를 띄워놓고 거대한 백엔드 4개를 올리려 한다고 가정해 보겠습니다. 보시다시피 클러스터 탭에서 분석한 가용량 대비 요청량이 초과되면, Grad-Deploy는 즉시 빨간색 배너와 함께 배포를 멈추고 서버 증설이나 Replica 감소를 유도합니다."

---

## 시나리오 2: Private 레지스트리 권한 누락으로 인한 ImagePullBackOff (VE-04 방어)

### 🚨 문제 발생 상황 (일반적인 Kubernetes 배포 시)
팀의 소스코드를 보호하기 위해 Docker Hub를 Private 레포지토리로 변경했습니다. 하지만 쿠버네티스 Deployment 매니페스트에 `imagePullSecrets`을 추가하는 것을 깜빡했습니다. 쿠버네티스는 계속해서 이미지 다운로드를 재시도하다 결국 `ImagePullBackOff` 에러를 뿜어냅니다.

### 🛡 Grad-Deploy의 방어 (VE-04)
- **감지 및 차단**: 사용자가 컨테이너 레지스트리를 Docker Hub(또는 외부 Private Registry)로 설정할 경우, Guardrail Validation Engine(VE)은 각 서비스 명세에 `imagePullSecrets`가 매핑되어 있는지 확인합니다. 누락된 경우 **Warning 가드레일을 발동시켜 비공개 이미지 접근 권한 누락을 경고**합니다.
- **데모 설명**: "Private 레지스트리로 변경하는 순간, 쿠버네티스가 이미지를 당겨오기 위해 필요한 자격 증명(Secret) 설정이 누락되었다는 것을 Grad-Deploy가 즉시 감지합니다. 우리는 더 이상 파드가 에러를 뿜어낼 때까지 기다리지 않아도 됩니다."

---

## 시나리오 3: 필수 의존성 누락으로 인한 HPA 동작 불능 (GE-02 방어)

### 🚨 문제 발생 상황 (일반적인 Kubernetes 배포 시)
트래픽 폭주에 대비해 HPA(Horizontal Pod Autoscaler)를 설정했습니다. 하지만 `metrics-server`가 설치되지 않았거나, 정작 대상 파드에 **CPU Request 기준점**이 명시되어 있지 않아 HPA가 트래픽 부하를 계산하지 못하고 `<unknown>` 상태에 머물게 됩니다. 결과적으로 스케일 아웃이 되지 않아 서버가 다운됩니다.

### 🛡 Grad-Deploy의 방어 (GE-02 & RA-01)
- **감지 및 차단**: Guardrail Engine(GE)은 사용자가 HPA를 활성화했을 때, 해당 서비스에 `cpuReq`(CPU Request) 값이 비어있다면 논리적 결함으로 판단하여 **Error 가드레일을 발동**합니다. 기준점이 없으면 HPA가 동작할 수 없음을 배포 전에 경고하는 것입니다.
- **데모 설명**: "많은 초보자들이 HPA만 켜면 오토스케일링이 마법처럼 될 것이라 착각합니다. 하지만 Grad-Deploy는 HPA가 리소스를 기반으로 동작한다는 점을 알고 있으며, CPU Request가 누락되면 'HPA 동작 불가' 에러를 띄워 치명적인 설정 실수를 바로잡아 줍니다."
