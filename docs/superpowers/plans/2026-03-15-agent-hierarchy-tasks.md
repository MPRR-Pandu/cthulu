# Agent Leader/Subagent Hierarchy + Task System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `reportsTo` chain hierarchy, agent roles, and a minimal file-based task system with wakeup-on-assignment to Cthulu Studio.

**Architecture:** Two new fields on Agent (`reports_to`, `role`). Standalone TaskFileStore at `~/.cthulu/tasks/`. Task creation triggers `WakeupSource::Assignment` heartbeat. Pure SVG/DOM org chart UI as new `ActiveView`. Thin layer on top of existing systems — no core rewrites.

**Tech Stack:** Rust/Tauri (backend), React/TypeScript (frontend), JSON files (persistence), SVG (org chart)

---

## File Map

### Backend (Rust)
| File | Action | Purpose |
|------|--------|---------|
| `cthulu-backend/agents/mod.rs` | Modify | Add `reports_to`, `role` to Agent struct + AgentBuilder |
| `cthulu-backend/agents/tasks.rs` | Create | TaskFileStore: Task struct, CRUD, file persistence |
| `cthulu-backend/agents/mod.rs` | Modify | Add `pub mod tasks;` |
| `cthulu-backend/api/agents/handlers.rs` | Modify | Add `reports_to`, `role` to Update/Create handlers, cycle detection, orphan on delete |
| `cthulu-backend/api/agents/task_handlers.rs` | Create | HTTP handlers for task CRUD |
| `cthulu-backend/api/agents/mod.rs` | Modify | Register task routes |
| `cthulu-backend/api/mod.rs` | Modify | Add task_store to AppState |
| `cthulu-backend/lib.rs` | Modify | Initialize TaskFileStore on startup |
| `cthulu-backend/agents/heartbeat.rs` | Modify | Add `wakeup_with_source()` method, accept task context in prompt |

### Tauri Commands
| File | Action | Purpose |
|------|--------|---------|
| `cthulu-studio/src-tauri/src/commands/agents.rs` | Modify | Add `reports_to`, `role` to Create/Update requests + list_agents summary |
| `cthulu-studio/src-tauri/src/commands/tasks.rs` | Create | Tauri commands: list/create/update/delete tasks |
| `cthulu-studio/src-tauri/src/commands/mod.rs` | Modify | Add `pub mod tasks;` |
| `cthulu-studio/src-tauri/src/main.rs` | Modify | Register task commands |

### Frontend
| File | Action | Purpose |
|------|--------|---------|
| `cthulu-studio/src/types/flow.ts` | Modify | Add Task, TaskStatus, AGENT_ROLES, update Agent/AgentSummary |
| `cthulu-studio/src/api/client.ts` | Modify | Add task CRUD functions |
| `cthulu-studio/src/components/OrgChart.tsx` | Create | SVG/DOM org chart visualization |
| `cthulu-studio/src/components/TaskList.tsx` | Create | Task list panel for agent detail |
| `cthulu-studio/src/components/NewTaskDialog.tsx` | Create | Dialog to create/assign tasks |
| `cthulu-studio/src/components/AgentConfigPage.tsx` | Modify | Add role + reportsTo dropdowns |
| `cthulu-studio/src/components/AgentDetailPage.tsx` | Modify | Add Tasks tab |
| `cthulu-studio/src/components/AgentListPage.tsx` | Modify | Add "Org Chart" button |
| `cthulu-studio/src/components/TopBar.tsx` | Modify | Add org-chart view handling |
| `cthulu-studio/src/App.tsx` | Modify | Route org-chart ActiveView |
| `cthulu-studio/src/styles.css` | Modify | Add org chart + task list styles |

---

## Chunk 1: Backend — Agent Hierarchy Fields

### Task 1: Add `reports_to` and `role` to Agent struct

**Files:**
- Modify: `cthulu-backend/agents/mod.rs:80-127` (Agent struct)
- Modify: `cthulu-backend/agents/mod.rs:159-176` (AgentBuilder)
- Modify: `cthulu-backend/agents/mod.rs:276-300` (build method)

- [ ] **Step 1: Add AGENT_ROLES constant and new fields to Agent**

After line 72 (`pub type SubAgents = ...`), add:

```rust
/// Valid agent roles in the org hierarchy.
pub const AGENT_ROLES: &[&str] = &[
    "ceo", "cto", "cmo", "cfo", "engineer", "designer",
    "pm", "qa", "devops", "researcher", "general",
];
```

Add two fields to the `Agent` struct (after line 96 `project` field):

```rust
    /// Agent ID this agent reports to (org hierarchy). None = top-level.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reports_to: Option<String>,
    /// Role in the organization (ceo, engineer, etc.).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
```

- [ ] **Step 2: Add fields to AgentBuilder**

Add to the AgentBuilder struct fields (after `project`):

```rust
    reports_to: Option<String>,
    role: Option<String>,
```

Initialize both to `None` in `Agent::builder()`.

Add builder methods in `impl<S> AgentBuilder<S>`:

```rust
    pub fn reports_to(mut self, r: impl Into<String>) -> Self {
        self.reports_to = Some(r.into());
        self
    }

    pub fn role(mut self, r: impl Into<String>) -> Self {
        self.role = Some(r.into());
        self
    }
```

Add to `build()` method output:

```rust
    reports_to: self.reports_to,
    role: self.role,
```

- [ ] **Step 3: Run `cargo check`**

### Task 2: Add hierarchy fields to handlers

**Files:**
- Modify: `cthulu-backend/api/agents/handlers.rs:50-69` (CreateAgentRequest)
- Modify: `cthulu-backend/api/agents/handlers.rs:71-107` (create_agent handler)
- Modify: `cthulu-backend/api/agents/handlers.rs:109-140` (UpdateAgentRequest)
- Modify: `cthulu-backend/api/agents/handlers.rs:142-222` (update_agent handler)
- Modify: `cthulu-backend/api/agents/handlers.rs:224-263` (delete_agent handler)
- Modify: `cthulu-backend/api/agents/handlers.rs:13-34` (list_agents summary)

- [ ] **Step 1: Add `reports_to` and `role` to CreateAgentRequest**

```rust
    #[serde(default)]
    reports_to: Option<String>,
    #[serde(default)]
    role: Option<String>,
```

Wire them in `create_agent` handler using builder:

```rust
    if let Some(r) = body.reports_to {
        builder = builder.reports_to(r);
    }
    if let Some(r) = body.role {
        builder = builder.role(r);
    }
```

- [ ] **Step 2: Add to UpdateAgentRequest + update_agent handler**

Add fields:

```rust
    #[serde(default)]
    reports_to: Option<Option<String>>,
    #[serde(default)]
    role: Option<Option<String>>,
```

Apply in handler:

```rust
    if let Some(reports_to) = body.reports_to {
        // Cycle detection
        if let Some(ref target_id) = reports_to {
            if target_id == &id {
                return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "agent cannot report to itself" }))));
            }
            // Walk up the chain to detect cycles
            let mut current = target_id.clone();
            for _ in 0..100 {
                if let Some(parent) = state.agent_repo.get(&current).await {
                    match &parent.reports_to {
                        Some(parent_rt) if parent_rt == &id => {
                            return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "circular reporting chain detected" }))));
                        }
                        Some(parent_rt) => current = parent_rt.clone(),
                        None => break,
                    }
                } else {
                    break;
                }
            }
        }
        agent.reports_to = reports_to;
    }
    if let Some(role) = body.role {
        agent.role = role;
    }
```

- [ ] **Step 3: Orphan subordinates on delete**

In `delete_agent`, after confirming existence but before deleting:

```rust
    // Orphan any agents that reported to this one
    let all_agents = state.agent_repo.list().await;
    for mut subordinate in all_agents {
        if subordinate.reports_to.as_deref() == Some(&id) {
            subordinate.reports_to = None;
            subordinate.updated_at = Utc::now();
            let _ = state.agent_repo.save(subordinate).await;
        }
    }
```

- [ ] **Step 4: Add to list_agents summary JSON**

Add `"reports_to": a.reports_to, "role": a.role` to the summary JSON object.

- [ ] **Step 5: Run `cargo check`**

### Task 3: Mirror hierarchy fields in Tauri commands

**Files:**
- Modify: `cthulu-studio/src-tauri/src/commands/agents.rs:64-83` (CreateAgentRequest)
- Modify: `cthulu-studio/src-tauri/src/commands/agents.rs:85-123` (create_agent)
- Modify: `cthulu-studio/src-tauri/src/commands/agents.rs:129-162` (UpdateAgentRequest)
- Modify: `cthulu-studio/src-tauri/src/commands/agents.rs:164-248` (update_agent)
- Modify: `cthulu-studio/src-tauri/src/commands/agents.rs:254-289` (delete_agent)
- Modify: `cthulu-studio/src-tauri/src/commands/agents.rs:11-38` (list_agents summary)

- [ ] **Step 1: Add fields to CreateAgentRequest + create_agent**

Same pattern as HTTP handler.

- [ ] **Step 2: Add fields to UpdateAgentRequest + update_agent with cycle detection**

Same cycle detection logic as HTTP handler.

- [ ] **Step 3: Add orphan logic to delete_agent**

- [ ] **Step 4: Add to list_agents summary**

- [ ] **Step 5: Run `cargo check`**

---

## Chunk 2: Backend — Task Store + Heartbeat Wakeup

### Task 4: Create TaskFileStore

**Files:**
- Create: `cthulu-backend/agents/tasks.rs`
- Modify: `cthulu-backend/agents/mod.rs` (add `pub mod tasks;`)

- [ ] **Step 1: Create tasks.rs with Task struct and TaskFileStore**

```rust
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Todo,
    InProgress,
    Done,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
    pub assignee_agent_id: String,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub struct TaskFileStore {
    dir: PathBuf,
    cache: Arc<RwLock<HashMap<String, Task>>>,
}

impl TaskFileStore {
    pub async fn new(data_dir: &Path) -> Self {
        let dir = data_dir.join("tasks");
        let _ = tokio::fs::create_dir_all(&dir).await;

        let store = Self {
            dir,
            cache: Arc::new(RwLock::new(HashMap::new())),
        };
        store.load_all().await;
        store
    }

    async fn load_all(&self) {
        let mut tasks = HashMap::new();
        if let Ok(mut entries) = tokio::fs::read_dir(&self.dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                if path.extension().map(|e| e == "json").unwrap_or(false) {
                    if let Ok(content) = tokio::fs::read_to_string(&path).await {
                        if let Ok(task) = serde_json::from_str::<Task>(&content) {
                            tasks.insert(task.id.clone(), task);
                        }
                    }
                }
            }
        }
        *self.cache.write().await = tasks;
    }

    pub async fn list(&self) -> Vec<Task> {
        let cache = self.cache.read().await;
        let mut tasks: Vec<Task> = cache.values().cloned().collect();
        tasks.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        tasks
    }

    pub async fn list_for_agent(&self, agent_id: &str) -> Vec<Task> {
        let cache = self.cache.read().await;
        let mut tasks: Vec<Task> = cache
            .values()
            .filter(|t| t.assignee_agent_id == agent_id)
            .cloned()
            .collect();
        tasks.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        tasks
    }

    pub async fn get(&self, id: &str) -> Option<Task> {
        self.cache.read().await.get(id).cloned()
    }

    pub async fn save(&self, task: Task) -> Result<(), String> {
        let json = serde_json::to_string_pretty(&task)
            .map_err(|e| format!("serialize task: {e}"))?;
        let path = self.dir.join(format!("{}.json", task.id));
        let tmp = path.with_extension("json.tmp");
        tokio::fs::write(&tmp, &json)
            .await
            .map_err(|e| format!("write task: {e}"))?;
        tokio::fs::rename(&tmp, &path)
            .await
            .map_err(|e| format!("rename task: {e}"))?;
        self.cache.write().await.insert(task.id.clone(), task);
        Ok(())
    }

    pub async fn delete(&self, id: &str) -> Result<bool, String> {
        let path = self.dir.join(format!("{id}.json"));
        if path.exists() {
            tokio::fs::remove_file(&path)
                .await
                .map_err(|e| format!("delete task: {e}"))?;
            self.cache.write().await.remove(id);
            Ok(true)
        } else {
            Ok(false)
        }
    }
}
```

- [ ] **Step 2: Add `pub mod tasks;` to agents/mod.rs**

- [ ] **Step 3: Run `cargo check`**

### Task 5: Wire TaskFileStore into AppState + startup

**Files:**
- Modify: `cthulu-backend/api/mod.rs` (AppState)
- Modify: `cthulu-backend/lib.rs` (initialization)

- [ ] **Step 1: Add `task_store` to AppState**

```rust
pub task_store: Arc<crate::agents::tasks::TaskFileStore>,
```

- [ ] **Step 2: Initialize in lib.rs**

After agent repo init, before heartbeat scheduler:

```rust
let task_store = Arc::new(crate::agents::tasks::TaskFileStore::new(&data_dir).await);
```

Pass to AppState construction.

- [ ] **Step 3: Run `cargo check`**

### Task 6: Add wakeup_with_source to heartbeat

**Files:**
- Modify: `cthulu-backend/agents/heartbeat.rs:233-249` (wakeup method)

- [ ] **Step 1: Add `wakeup_with_source` method**

After the existing `wakeup()` method, add:

```rust
    /// Trigger a heartbeat with a specific source and optional task context.
    pub async fn wakeup_with_source(
        &self,
        agent_id: &str,
        source: WakeupSource,
        task_context: Option<&str>,
    ) -> Result<HeartbeatRun, String> {
        let mut agent = self
            .agent_repo
            .get(agent_id)
            .await
            .ok_or_else(|| format!("agent not found: {agent_id}"))?;

        // Check concurrent run guard
        if let Some(active_id) = read_active_run(&self.data_dir, agent_id) {
            return Err(format!(
                "agent already has an active run: {active_id}. Wait for it to complete."
            ));
        }

        // If task context provided, append it to the heartbeat prompt for this run
        if let Some(ctx) = task_context {
            agent.heartbeat_prompt_template = format!(
                "{}\n\n## New Assignment\n{}",
                agent.heartbeat_prompt_template, ctx
            );
        }

        self.execute_heartbeat(&agent, source).await
    }
```

- [ ] **Step 2: Run `cargo check`**

### Task 7: Create HTTP task handlers

**Files:**
- Create: `cthulu-backend/api/agents/task_handlers.rs`
- Modify: `cthulu-backend/api/agents/mod.rs` (register routes)

- [ ] **Step 1: Create task_handlers.rs**

```rust
use axum::extract::{Path, Query, State};
use axum::Json;
use chrono::Utc;
use hyper::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::agents::heartbeat::WakeupSource;
use crate::agents::tasks::{Task, TaskStatus};
use crate::api::AppState;

#[derive(Deserialize)]
pub(crate) struct ListTasksQuery {
    pub assignee: Option<String>,
}

pub(crate) async fn list_tasks(
    State(state): State<AppState>,
    Query(query): Query<ListTasksQuery>,
) -> Json<Value> {
    let tasks = if let Some(ref agent_id) = query.assignee {
        state.task_store.list_for_agent(agent_id).await
    } else {
        state.task_store.list().await
    };
    Json(json!({ "tasks": tasks }))
}

#[derive(Deserialize)]
pub(crate) struct CreateTaskRequest {
    title: String,
    assignee_agent_id: String,
}

pub(crate) async fn create_task(
    State(state): State<AppState>,
    Json(body): Json<CreateTaskRequest>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    // Verify assignee exists
    if state.agent_repo.get(&body.assignee_agent_id).await.is_none() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "assignee agent not found" })),
        ));
    }

    let now = Utc::now();
    let task = Task {
        id: uuid::Uuid::new_v4().to_string(),
        title: body.title.clone(),
        status: TaskStatus::Todo,
        assignee_agent_id: body.assignee_agent_id.clone(),
        created_by: "user".into(),
        created_at: now,
        updated_at: now,
    };

    state.task_store.save(task.clone()).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e })))
    })?;

    // Trigger assignment wakeup
    let scheduler = state.heartbeat_scheduler.read().await;
    let task_context = format!("Task: {}", body.title);
    let _ = scheduler
        .wakeup_with_source(&body.assignee_agent_id, WakeupSource::Assignment, Some(&task_context))
        .await;

    Ok((StatusCode::CREATED, Json(serde_json::to_value(&task).unwrap())))
}

#[derive(Deserialize)]
pub(crate) struct UpdateTaskRequest {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    status: Option<TaskStatus>,
    #[serde(default)]
    assignee_agent_id: Option<String>,
}

pub(crate) async fn update_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    Json(body): Json<UpdateTaskRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let mut task = state.task_store.get(&task_id).await.ok_or_else(|| {
        (StatusCode::NOT_FOUND, Json(json!({ "error": "task not found" })))
    })?;

    let old_assignee = task.assignee_agent_id.clone();

    if let Some(title) = body.title {
        task.title = title;
    }
    if let Some(status) = body.status {
        task.status = status;
    }
    if let Some(ref assignee) = body.assignee_agent_id {
        if state.agent_repo.get(assignee).await.is_none() {
            return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "assignee agent not found" }))));
        }
        task.assignee_agent_id = assignee.clone();
    }
    task.updated_at = Utc::now();

    state.task_store.save(task.clone()).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e })))
    })?;

    // If assignee changed, wakeup the new assignee
    if let Some(new_assignee) = body.assignee_agent_id {
        if new_assignee != old_assignee {
            let scheduler = state.heartbeat_scheduler.read().await;
            let task_context = format!("Task reassigned to you: {}", task.title);
            let _ = scheduler
                .wakeup_with_source(&new_assignee, WakeupSource::Assignment, Some(&task_context))
                .await;
        }
    }

    Ok(Json(serde_json::to_value(&task).unwrap()))
}

pub(crate) async fn delete_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let existed = state.task_store.delete(&task_id).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e })))
    })?;

    if !existed {
        return Err((StatusCode::NOT_FOUND, Json(json!({ "error": "task not found" }))));
    }

    Ok(Json(json!({ "deleted": true })))
}
```

- [ ] **Step 2: Register routes in api/agents/mod.rs**

Add `pub mod task_handlers;` and add routes:

```rust
        // Tasks
        .route("/agents/tasks", get(task_handlers::list_tasks).post(task_handlers::create_task))
        .route("/agents/tasks/{id}", axum::routing::put(task_handlers::update_task).delete(task_handlers::delete_task))
```

Place the `/agents/tasks` route BEFORE `/agents/{id}` to avoid capture.

- [ ] **Step 3: Run `cargo check`**

---

## Chunk 3: Tauri Task Commands

### Task 8: Create Tauri task commands

**Files:**
- Create: `cthulu-studio/src-tauri/src/commands/tasks.rs`
- Modify: `cthulu-studio/src-tauri/src/commands/mod.rs`
- Modify: `cthulu-studio/src-tauri/src/main.rs`

- [ ] **Step 1: Create tasks.rs**

```rust
use serde::Deserialize;
use serde_json::{json, Value};

use cthulu::agents::heartbeat::WakeupSource;
use cthulu::agents::tasks::{Task, TaskStatus};
use cthulu::api::AppState;

#[tauri::command]
pub async fn list_tasks(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    assignee: Option<String>,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;
    let tasks = if let Some(ref agent_id) = assignee {
        state.task_store.list_for_agent(agent_id).await
    } else {
        state.task_store.list().await
    };
    Ok(json!({ "tasks": tasks }))
}

#[derive(Deserialize)]
pub struct CreateTaskRequest {
    title: String,
    assignee_agent_id: String,
}

#[tauri::command]
pub async fn create_task(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    request: CreateTaskRequest,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    if state.agent_repo.get(&request.assignee_agent_id).await.is_none() {
        return Err("assignee agent not found".to_string());
    }

    let now = chrono::Utc::now();
    let task = Task {
        id: uuid::Uuid::new_v4().to_string(),
        title: request.title.clone(),
        status: TaskStatus::Todo,
        assignee_agent_id: request.assignee_agent_id.clone(),
        created_by: "user".into(),
        created_at: now,
        updated_at: now,
    };

    state.task_store.save(task.clone()).await?;

    // Trigger assignment wakeup
    let scheduler = state.heartbeat_scheduler.read().await;
    let task_context = format!("Task: {}", request.title);
    let _ = scheduler
        .wakeup_with_source(&request.assignee_agent_id, WakeupSource::Assignment, Some(&task_context))
        .await;

    serde_json::to_value(&task).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct UpdateTaskRequest {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    status: Option<TaskStatus>,
    #[serde(default)]
    assignee_agent_id: Option<String>,
}

#[tauri::command]
pub async fn update_task(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    id: String,
    request: UpdateTaskRequest,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    let mut task = state.task_store.get(&id).await
        .ok_or_else(|| "task not found".to_string())?;

    let old_assignee = task.assignee_agent_id.clone();

    if let Some(title) = request.title {
        task.title = title;
    }
    if let Some(status) = request.status {
        task.status = status;
    }
    if let Some(ref assignee) = request.assignee_agent_id {
        if state.agent_repo.get(assignee).await.is_none() {
            return Err("assignee agent not found".to_string());
        }
        task.assignee_agent_id = assignee.clone();
    }
    task.updated_at = chrono::Utc::now();

    state.task_store.save(task.clone()).await?;

    // If assignee changed, wakeup new assignee
    if let Some(new_assignee) = request.assignee_agent_id {
        if new_assignee != old_assignee {
            let scheduler = state.heartbeat_scheduler.read().await;
            let task_context = format!("Task reassigned to you: {}", task.title);
            let _ = scheduler
                .wakeup_with_source(&new_assignee, WakeupSource::Assignment, Some(&task_context))
                .await;
        }
    }

    serde_json::to_value(&task).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_task(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    id: String,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;
    let existed = state.task_store.delete(&id).await?;
    if !existed {
        return Err("task not found".to_string());
    }
    Ok(json!({ "deleted": true }))
}
```

- [ ] **Step 2: Add `pub mod tasks;` to commands/mod.rs**

- [ ] **Step 3: Register in main.rs invoke_handler**

Add after `// Agent Repo` section:

```rust
            // Tasks
            commands::tasks::list_tasks,
            commands::tasks::create_task,
            commands::tasks::update_task,
            commands::tasks::delete_task,
```

- [ ] **Step 4: Run `cargo check`**

---

## Chunk 4: Frontend — Types + API Client

### Task 9: Update TypeScript types

**Files:**
- Modify: `cthulu-studio/src/types/flow.ts`

- [ ] **Step 1: Add AGENT_ROLES, TaskStatus, Task types + update Agent/AgentSummary**

Add after the HeartbeatRun interface:

```typescript
// ---------------------------------------------------------------------------
// Agent Hierarchy
// ---------------------------------------------------------------------------

export const AGENT_ROLES = [
  "ceo", "cto", "cmo", "cfo", "engineer", "designer",
  "pm", "qa", "devops", "researcher", "general",
] as const;

export type AgentRole = typeof AGENT_ROLES[number];

export const ROLE_LABELS: Record<AgentRole, string> = {
  ceo: "CEO",
  cto: "CTO",
  cmo: "CMO",
  cfo: "CFO",
  engineer: "Engineer",
  designer: "Designer",
  pm: "Product Manager",
  qa: "QA",
  devops: "DevOps",
  researcher: "Researcher",
  general: "General",
};

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  assignee_agent_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}
```

Add to Agent interface (after `project`):

```typescript
  reports_to?: string | null;
  role?: string | null;
```

Add to AgentSummary (after `project`):

```typescript
  reports_to?: string | null;
  role?: string | null;
```

Update `ActiveView` to include `"org-chart"`:

```typescript
export type ActiveView = "flow-editor" | "agent-workspace" | "agent-list" | "agent-detail" | "prompt-editor" | "workflows" | "org-chart";
```

- [ ] **Step 2: Run `npx nx build cthulu-studio` to check types**

### Task 10: Add task API functions to client.ts

**Files:**
- Modify: `cthulu-studio/src/api/client.ts`

- [ ] **Step 1: Add task CRUD functions**

After the agent repo section:

```typescript
// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function listTasks(assignee?: string): Promise<Task[]> {
  log("http", `invoke list_tasks assignee=${assignee ?? "all"}`);
  const data = await invoke<{ tasks: Task[] }>("list_tasks", { assignee: assignee ?? null });
  return data.tasks;
}

export async function createTask(title: string, assigneeAgentId: string): Promise<Task> {
  log("http", `invoke create_task title=${title} assignee=${assigneeAgentId}`);
  return invoke<Task>("create_task", {
    request: { title, assignee_agent_id: assigneeAgentId },
  });
}

export async function updateTask(
  id: string,
  updates: { title?: string; status?: string; assignee_agent_id?: string }
): Promise<Task> {
  log("http", `invoke update_task id=${id}`);
  return invoke<Task>("update_task", { id, request: updates });
}

export async function deleteTask(id: string): Promise<void> {
  log("http", `invoke delete_task id=${id}`);
  await invoke("delete_task", { id });
}
```

Add `Task` to the imports from `../types/flow`.

- [ ] **Step 2: Run `npx nx build cthulu-studio`**

---

## Chunk 5: Frontend — Org Chart Page

### Task 11: Create OrgChart component

**Files:**
- Create: `cthulu-studio/src/components/OrgChart.tsx`

- [ ] **Step 1: Create OrgChart.tsx — pure SVG/DOM tree layout**

Pure component that:
1. Takes agents list, builds a tree from `reports_to` chains
2. Uses a recursive `subtreeWidth()` + `layoutTree()` approach (like Paperclip)
3. Renders cards with role badges, status dots, agent names
4. SVG lines connecting parent to child
5. Pan/zoom via mouse events on container
6. Click card to navigate to agent detail

Key structure:
- `OrgNode` type: `{ agent: AgentSummary, x: number, y: number, children: OrgNode[] }`
- `buildForest(agents)`: groups by `reports_to`, returns array of root trees
- `layoutForest(forest)`: assigns x,y coordinates
- Render: `<div>` container with transform for pan/zoom, SVG `<path>` for edges, HTML cards positioned with `position: absolute`

- [ ] **Step 2: Add org chart styles to styles.css**

- [ ] **Step 3: Run `npx nx build cthulu-studio`**

### Task 12: Wire org-chart into App routing

**Files:**
- Modify: `cthulu-studio/src/App.tsx`
- Modify: `cthulu-studio/src/components/AgentListPage.tsx`
- Modify: `cthulu-studio/src/components/TopBar.tsx`

- [ ] **Step 1: Add org-chart case in App.tsx view router**

In the main content area switch/conditional:

```tsx
{activeView === "org-chart" && <OrgChart />}
```

- [ ] **Step 2: Add "Org Chart" button in AgentListPage header**

A button next to the filter tabs that switches to `org-chart` view.

- [ ] **Step 3: Handle org-chart in TopBar back button logic**

- [ ] **Step 4: Run `npx nx build cthulu-studio`**

---

## Chunk 6: Frontend — Task List + Agent Config Updates

### Task 13: Create TaskList component

**Files:**
- Create: `cthulu-studio/src/components/TaskList.tsx`
- Create: `cthulu-studio/src/components/NewTaskDialog.tsx`

- [ ] **Step 1: Create TaskList.tsx**

Panel showing tasks for a specific agent:
- Filter: All / Todo / In Progress / Done
- Each task row: title, status badge, created date, actions (status change, delete)
- "New Task" button opens NewTaskDialog
- Uses `api.listTasks(agentId)` to load

- [ ] **Step 2: Create NewTaskDialog.tsx**

Dialog with:
- Title input
- Assignee dropdown (pre-filled if opened from agent detail)
- Create button triggers `api.createTask()`

- [ ] **Step 3: Add task list styles to styles.css**

- [ ] **Step 4: Run `npx nx build cthulu-studio`**

### Task 14: Add Tasks tab to AgentDetailPage

**Files:**
- Modify: `cthulu-studio/src/components/AgentDetailPage.tsx`

- [ ] **Step 1: Add "Tasks" as 4th tab**

After the existing 3 tabs (Dashboard/Configuration/Runs), add a Tasks tab that renders `<TaskList agentId={agentId} />`.

- [ ] **Step 2: Run `npx nx build cthulu-studio`**

### Task 15: Add role + reportsTo to AgentConfigPage

**Files:**
- Modify: `cthulu-studio/src/components/AgentConfigPage.tsx`

- [ ] **Step 1: Add "Hierarchy" card to config page**

New card with:
- Role dropdown (select from AGENT_ROLES + "None")
- Reports To dropdown (select from other agents + "None")
- Both fields save via `api.updateAgent()`

- [ ] **Step 2: Add hierarchy fields to the save handler**

Include `reports_to` and `role` in the `updateAgent()` call.

- [ ] **Step 3: Run `npx nx build cthulu-studio`**

---

## Chunk 7: Build Verification

### Task 16: Full build verification

- [ ] **Step 1: Run `cargo check`**
- [ ] **Step 2: Run `npx nx build cthulu-studio`**
- [ ] **Step 3: Fix any errors**
