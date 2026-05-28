# AI Task Brief: Grad-Deploy Today Tasks

Date: 2026-05-20  
Project: Grad-Deploy v2  
Workspace: `/Users/leeon/Documents/graddeploy`

## Context

Grad-Deploy is a Kubernetes GitOps guardrail platform for student developers.

The current local workspace is based on the teammate's latest remote version `f8d7b18` plus the restored CA, Cluster Advisor, feature.

Current important files:

```text
src/App.jsx
src/engines/ca.js
src/components/ClusterAdvisorPanel.jsx
src/hooks/useStore_improved.js
src/components/ServiceCard_integrated.jsx
src/generators/k8s_improved.js
src/components/DeployPanel.jsx
src/utils/envManager.js
server/index.js
```

The app currently builds successfully with:

```bash
npm run build
```

The local dev server can be started with:

```bash
npm run dev -- --host 0.0.0.0
```

Expected URL:

```text
http://localhost:5173/
```

## Current State

Implemented:

- Service configuration UI
- Kubernetes YAML generation
- GitHub Actions YAML generation
- Argo CD YAML generation
- GitHub repo push flow
- Env editor for ConfigMap/Secret-like variables
- Improved service templates
- kind/minikube related generation
- Argo CD auto setup attempt
- GitHub SSO/RBAC YAML generation
- ApplicationSet/AppProject generation logic
- Cluster Advisor UI restored
- Browser resource detection
- VM script output parsing

Not fully implemented:

- CA result is not connected to RA/resource recommendation logic
- GitHub push is still file-by-file, not a single commit
- `kustomization.yaml` image `newTag` generation/update is unstable
- GHCR private image pull secret handling is missing
- Argo CD status dashboard is missing
- zrok external URL exposure is missing
- Multi-user panel exists but is not fully connected to the main app
- Secret handling needs cleanup

## Today's Goal

Prepare the project for tomorrow's team meeting and enable a reliable MVP validation path.

The main goal today is not to complete every feature, but to:

1. Verify the current app runs.
2. Verify the Cluster Advisor screen works.
3. Prepare a test service plan for frontend + backend + database.
4. Identify the next implementation target clearly.
5. Avoid breaking the teammate's newly added structure.

## Task 1: Verify App Startup

Run:

```bash
cd /Users/leeon/Documents/graddeploy
npm run dev -- --host 0.0.0.0
```

Open:

```text
http://localhost:5173/
```

Check these screens:

- Services tab
- Cluster tab
- Guardrail tab
- Topology tab
- Deploy tab
- YAML preview panel

Acceptance criteria:

```text
The app opens without a white screen.
The Cluster tab is visible.
The Cluster Advisor panel renders.
YAML preview still works.
No obvious runtime error appears in the browser console.
```

## Task 2: Verify Cluster Advisor Behavior

Go to the Cluster tab.

Test Local PC:

```text
Select Local PC.
Check browser CPU/RAM detection text.
Chrome should show better CPU/RAM hints than Safari.
RAM may be shown as "8GB+" due to browser API limitation.
```

Test VM/manual:

```text
Select VM.
Enter host: 6core / 11GB.
Enter one master node: 4core / 8GB.
Enter one worker node: 2core / 2GB.
Confirm CA output is reasonable.
```

Test VM/script parsing:

Paste this sample:

```text
CPU=4, MEM=7GB
Allocatable:
  cpu:                4
  ephemeral-storage:  37286723113
  hugepages-1Gi:      0
  hugepages-2Mi:      0
  memory:             8024408Ki
--
Allocatable:
  cpu:                2
  ephemeral-storage:  17714302128
  hugepages-1Gi:      0
  hugepages-2Mi:      0
  memory:             3906576Ki
--
Allocatable:
  cpu:                1
  ephemeral-storage:  17714302128
  hugepages-1Gi:      0
  hugepages-2Mi:      0
  memory:             1867Mi
--
Allocatable:
  cpu:                1
  ephemeral-storage:  17714302128
  hugepages-1Gi:      0
  hugepages-2Mi:      0
  memory:             1911920Ki
```

Expected:

```text
The parser should detect 4 nodes.
The first node should be treated as master.
The remaining nodes should be workers.
The CA result should show available CPU/memory based on worker allocatable resources.
The small "parsing completed" message should appear briefly.
```

Acceptance criteria:

```text
No crash while switching environments.
No crash while editing numeric fields.
The CA result explains that available memory is schedulable request budget, not current free memory.
```

## Task 3: Prepare Frontend + Backend + Database Test Service Plan

Create or document a minimal 3-service test app plan.

Recommended stack:

```text
frontend:
  React or nginx static frontend
  port: 80

backend:
  Node.js Express or Spring Boot
  port: 8080

database:
  MySQL
  port: 3306
```

The backend should expose:

```text
GET /health
GET /api/message
POST /api/message
```

The frontend should:

```text
Call backend /health.
Display current backend status.
Read a message from DB through backend.
Write a message to DB through backend.
Display image version or app version if possible.
```

The database should have one table:

```sql
CREATE TABLE messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  content VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Acceptance criteria:

```text
The test service plan is clear enough for another teammate or AI agent to implement.
The resource requests are small enough for minikube.
```

Recommended resource values:

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

## Task 4: Identify the Next Implementation Target

The recommended next implementation target is:

```text
Connect CA output to RA/guardrail calculation.
```

Desired behavior:

```text
Cluster Advisor calculates availableCPU and availableMem.
The result is stored in app state.
The RA/Guardrail engine uses this capacity.
If service total requests exceed cluster capacity, show ERROR.
If ERROR exists, disable deploy.
```

Suggested state shape:

```js
clusterCapacity: {
  env: 'local' | 'vm' | 'cloud',
  availableCPU: 1800,
  availableMem: 3500,
  workloadNodeCount: 2,
  hasError: false,
}
```

Suggested rule:

```text
RA-CA-01 ERROR:
Total requested CPU exceeds Cluster Advisor available CPU.

RA-CA-02 ERROR:
Total requested memory exceeds Cluster Advisor available memory.
```

Important:

```text
Do not remove existing guardrail rules.
Do not rewrite the whole engine.
Add a small, isolated integration path.
```

## Task 5: Meeting Preparation Checklist

Before the meeting, capture or prepare:

```text
1. Screenshot of Services tab.
2. Screenshot of Cluster Advisor local detection.
3. Screenshot of VM parsing result.
4. Screenshot of Deploy tab.
5. A short explanation of what is implemented.
6. A short explanation of what is not implemented.
7. Decision points for the team.
```

Decision points:

```text
1. App of Apps vs ApplicationSet.
2. Keep minikube now or move to k3s in semester 2.
3. Use central GitOps repo or user repo directly.
4. Handle GHCR private images by public package guide or imagePullSecret automation.
5. Include zrok in MVP or keep it as phase 1.5.
6. Who owns CA → RA integration.
```

## Constraints

Do not break:

```text
src/hooks/useStore_improved.js
src/components/ServiceCard_integrated.jsx
src/generators/k8s_improved.js
src/components/DeployPanel.jsx
```

Do not remove:

```text
src/engines/ca.js
src/components/ClusterAdvisorPanel.jsx
```

Do not rewrite the whole app.

Prefer small patches that preserve the teammate's latest structure.

Always run:

```bash
npm run build
```

after code changes.

## Deliverables

The AI agent should produce:

```text
1. A short summary of what was verified.
2. Any screenshots or notes from manual testing.
3. A list of found bugs.
4. If code was changed, list the changed files.
5. Confirm whether npm run build passes.
```

