# Agent Repo Sync Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub repo sync for agent definitions, allowing agents to be published to a private `cthulu-agents` repo and synced across machines.

**Architecture:** Mirror the existing `cthulu-workflows` pattern — Tauri commands with inline GitHub Contents API calls via `reqwest`. Agents get a new `project` field. Split format in repo (`agent.json` + `prompt.md`). Two local directories: `~/.cthulu/agents/` (runtime) and `~/.cthulu/cthulu-agents/` (sync mirror).

**Tech Stack:** Rust (Tauri commands), reqwest (GitHub API), serde_json, base64, React/TypeScript (frontend UI)

**Spec:** `docs/superpowers/specs/2026-03-14-agent-repo-sync-design.md`

---

## Chunk 1: Backend Data Model + Tauri Commands

### Task 1: Add `project` field to Agent struct and builder

**Files:**
- Modify: `cthulu-backend/agents/mod.rs:80-124` (Agent struct)
- Modify: `cthulu-backend/agents/mod.rs:126-148` (Agent::builder)
- Modify: `cthulu-backend/agents/mod.rs:153-171` (AgentBuilder struct)
- Modify: `cthulu-backend/agents/mod.rs:174-196` (AgentBuilder<NeedsName>::name)
- Modify: `cthulu-backend/agents/mod.rs:198-263` (AgentBuilder<S> impl)
- Modify: `cthulu-backend/agents/mod.rs:265-289` (AgentBuilder<Ready>::build)

- [ ] **Step 1: Add `project` field to `Agent` struct**

In `cthulu-backend/agents/mod.rs`, add after the `working_dir` field (line 95):

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
```

- [ ] **Step 2: Add `project` field to `AgentBuilder` struct**

In the `AgentBuilder<State>` struct (line 153), add after `working_dir`:

```rust
    project: Option<String>,
```

- [ ] **Step 3: Initialize `project` in `Agent::builder()`**

In `Agent::builder()` (line 128), add after `working_dir: None,`:

```rust
            project: None,
```

- [ ] **Step 4: Carry `project` through `AgentBuilder<NeedsName>::name()` transition**

In the `.name()` method (line 175), add after `working_dir: self.working_dir,`:

```rust
            project: self.project,
```

- [ ] **Step 5: Add `project()` setter to `AgentBuilder<S>` impl**

In the generic impl block (line 198), add:

```rust
    pub fn project(mut self, p: impl Into<String>) -> Self { self.project = Some(p.into()); self }
```

- [ ] **Step 6: Add `project` to `AgentBuilder<Ready>::build()`**

In `.build()` (line 265), add after `working_dir: self.working_dir,`:

```rust
            project: self.project,
```

- [ ] **Step 7: Run cargo check**

Run: `cargo check`
Expected: Compiles successfully (no errors)

- [ ] **Step 8: Commit**

```bash
git add cthulu-backend/agents/mod.rs
git commit -m "feat: add project field to Agent struct for repo sync"
```

---

### Task 2: Update `list_agents` to include `project` in summaries

**Files:**
- Modify: `cthulu-studio/src-tauri/src/commands/agents.rs:11-37` (list_agents)

- [ ] **Step 1: Add `project` to the JSON summary in `list_agents`**

In `cthulu-studio/src-tauri/src/commands/agents.rs`, in the `list_agents` function, add after the `"updated_at"` field in the `json!({})` macro (around line 30):

```rust
                "project": a.project,
```

- [ ] **Step 2: Run cargo check**

Run: `cargo check`
Expected: Compiles successfully

- [ ] **Step 3: Commit**

```bash
git add cthulu-studio/src-tauri/src/commands/agents.rs
git commit -m "feat: include project field in agent list summaries"
```

---

### Task 3: Create `agent_repo.rs` Tauri commands

**Files:**
- Create: `cthulu-studio/src-tauri/src/commands/agent_repo.rs`
- Modify: `cthulu-studio/src-tauri/src/commands/mod.rs`
- Modify: `cthulu-studio/src-tauri/src/main.rs`

- [ ] **Step 1: Create `agent_repo.rs` with constants and helpers**

Create `cthulu-studio/src-tauri/src/commands/agent_repo.rs`:

```rust
use cthulu::api::AppState;
use base64::Engine as _;
use serde_json::{json, Value};
use std::path::PathBuf;

const REPO_NAME: &str = "cthulu-agents";
const SECRETS_KEY: &str = "agent_repo";

fn clone_dir(state: &AppState) -> PathBuf {
    state.data_dir.join(REPO_NAME)
}

async fn require_pat(state: &AppState) -> Result<String, String> {
    state
        .github_pat
        .read()
        .await
        .clone()
        .ok_or_else(|| "GitHub PAT not configured. Save a PAT first.".to_string())
}

fn read_owner(state: &AppState) -> Option<String> {
    let content = std::fs::read_to_string(&state.secrets_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;
    v[SECRETS_KEY]["owner"].as_str().map(String::from)
}

fn validate_project_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Project name cannot be empty".to_string());
    }
    if !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err("Project name must contain only lowercase letters, digits, and hyphens".to_string());
    }
    if name.starts_with('-') || name.ends_with('-') {
        return Err("Project name cannot start or end with a hyphen".to_string());
    }
    Ok(())
}
```

- [ ] **Step 2: Add `setup_agent_repo` command**

Append to `agent_repo.rs`:

```rust
#[tauri::command]
pub async fn setup_agent_repo(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;
    let pat = require_pat(&state).await?;

    // 1. Get authenticated user
    let user_resp = state
        .http_client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {}", pat))
        .header("User-Agent", "cthulu-studio")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("GitHub API error: {e}"))?;

    if !user_resp.status().is_success() {
        return Err("GitHub PAT is invalid or expired".to_string());
    }

    let user: Value = user_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse user response: {e}"))?;

    let username = user["login"]
        .as_str()
        .ok_or_else(|| "GitHub user response missing login field".to_string())?
        .to_string();

    // 2. Check if repo exists, create if not
    let repo_check = state
        .http_client
        .get(format!("https://api.github.com/repos/{}/{}", username, REPO_NAME))
        .header("Authorization", format!("Bearer {}", pat))
        .header("User-Agent", "cthulu-studio")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Failed to check repo: {e}"))?;

    let created = if repo_check.status() == reqwest::StatusCode::NOT_FOUND {
        let create_resp = state
            .http_client
            .post("https://api.github.com/user/repos")
            .header("Authorization", format!("Bearer {}", pat))
            .header("User-Agent", "cthulu-studio")
            .header("Accept", "application/vnd.github+json")
            .json(&json!({
                "name": REPO_NAME,
                "private": true,
                "description": "Cthulu Studio agent definitions",
                "auto_init": true,
            }))
            .send()
            .await
            .map_err(|e| format!("Failed to create repo: {e}"))?;

        let status = create_resp.status();
        if status == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
            // Repo already exists (race condition)
            false
        } else if !status.is_success() {
            let body = create_resp.text().await.unwrap_or_default();
            return Err(format!("Failed to create repo: {body}"));
        } else {
            true
        }
    } else {
        false
    };

    let repo_url = format!("https://github.com/{}/{}", username, REPO_NAME);

    // 3. Save owner to secrets.json
    {
        let secrets_path = &state.secrets_path;
        let mut secrets: Value = if secrets_path.exists() {
            let content = std::fs::read_to_string(secrets_path).unwrap_or_default();
            serde_json::from_str(&content).unwrap_or_else(|_| json!({}))
        } else {
            json!({})
        };

        secrets[SECRETS_KEY] = json!({
            "owner": username,
            "name": REPO_NAME,
        });

        let tmp_path = secrets_path.with_extension("json.tmp");
        let json_str = serde_json::to_string_pretty(&secrets).unwrap_or_default();
        std::fs::write(&tmp_path, &json_str)
            .map_err(|e| format!("Failed to write secrets: {e}"))?;
        std::fs::rename(&tmp_path, secrets_path)
            .map_err(|e| format!("Failed to save secrets: {e}"))?;
    }

    // 4. Create local clone directory
    let clone_path = clone_dir(&state);
    if !clone_path.exists() {
        std::fs::create_dir_all(&clone_path)
            .map_err(|e| format!("Failed to create local agents directory: {e}"))?;
    }

    Ok(json!({
        "repo_url": repo_url,
        "created": created,
        "username": username,
    }))
}
```

- [ ] **Step 3: Add `list_agent_projects` command**

Append to `agent_repo.rs`:

```rust
#[tauri::command]
pub async fn list_agent_projects(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;
    let clone_path = clone_dir(&state);
    let projects_dir = clone_path.join("projects");

    let mut projects = Vec::new();
    if projects_dir.exists() {
        let entries = std::fs::read_dir(&projects_dir)
            .map_err(|e| format!("Failed to read projects directory: {e}"))?;
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if let Some(name) = entry.file_name().to_str() {
                    projects.push(name.to_string());
                }
            }
        }
    }
    projects.sort();

    Ok(json!({ "projects": projects }))
}
```

- [ ] **Step 4: Add `create_agent_project` command**

Append to `agent_repo.rs`:

```rust
#[tauri::command]
pub async fn create_agent_project(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    project: String,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;
    validate_project_name(&project)?;
    let pat = require_pat(&state).await?;
    let owner = read_owner(&state)
        .ok_or_else(|| "Agent repo not set up. Run setup first.".to_string())?;

    // Create local directory
    let clone_path = clone_dir(&state);
    let project_dir = clone_path.join("projects").join(&project).join("agents");
    std::fs::create_dir_all(&project_dir)
        .map_err(|e| format!("Failed to create project directory: {e}"))?;

    // Push .gitkeep to GitHub
    let gh_path = format!("projects/{}/agents/.gitkeep", project);
    let gh_url = format!(
        "https://api.github.com/repos/{}/{}/contents/{}",
        owner, REPO_NAME, gh_path
    );

    let encoded = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        b"",
    );

    let body = json!({
        "message": format!("Create project: {}", project),
        "content": encoded,
    });

    let resp = state
        .http_client
        .put(&gh_url)
        .header("Authorization", format!("Bearer {}", pat))
        .header("User-Agent", "cthulu-studio")
        .header("Accept", "application/vnd.github+json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("GitHub PUT error: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        // 422 = file already exists, that's okay
        if !body.contains("\"sha\"") {
            return Err(format!("GitHub PUT error: {body}"));
        }
    }

    Ok(json!({ "ok": true, "project": project }))
}
```

- [ ] **Step 5: Add `publish_agent` command**

Append to `agent_repo.rs`:

```rust
#[tauri::command]
pub async fn publish_agent(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    id: String,
    project: String,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;
    validate_project_name(&project)?;
    let pat = require_pat(&state).await?;
    let owner = read_owner(&state)
        .ok_or_else(|| "Agent repo not set up. Run setup first.".to_string())?;

    // 1. Read agent from runtime store
    let mut agent = state
        .agent_repo
        .get(&id)
        .await
        .ok_or_else(|| "Agent not found".to_string())?;

    // 2. Update agent's project field and save to runtime store
    agent.project = Some(project.clone());
    agent.updated_at = chrono::Utc::now();
    state
        .agent_repo
        .save(agent.clone())
        .await
        .map_err(|e| format!("Failed to save agent: {e}"))?;

    // 3. Split into agent.json (no prompt) + prompt.md
    let prompt_content = agent.prompt.clone();
    let mut agent_json = serde_json::to_value(&agent)
        .map_err(|e| format!("Failed to serialize agent: {e}"))?;
    // Remove prompt and project from agent.json (prompt goes to prompt.md, project derived from path)
    if let Some(obj) = agent_json.as_object_mut() {
        obj.remove("prompt");
        obj.remove("project");
    }
    let agent_json_str = serde_json::to_string_pretty(&agent_json)
        .map_err(|e| format!("Failed to format agent JSON: {e}"))?;

    // 4. Write to local sync directory
    let clone_path = clone_dir(&state);
    let agent_dir = clone_path.join("projects").join(&project).join("agents").join(&id);
    std::fs::create_dir_all(&agent_dir)
        .map_err(|e| format!("Failed to create agent sync directory: {e}"))?;

    let local_json_path = agent_dir.join("agent.json");
    let tmp_json = local_json_path.with_extension("json.tmp");
    std::fs::write(&tmp_json, &agent_json_str)
        .map_err(|e| format!("Failed to write agent.json: {e}"))?;
    std::fs::rename(&tmp_json, &local_json_path)
        .map_err(|e| format!("Failed to save agent.json: {e}"))?;

    let local_prompt_path = agent_dir.join("prompt.md");
    let tmp_prompt = local_prompt_path.with_extension("md.tmp");
    std::fs::write(&tmp_prompt, &prompt_content)
        .map_err(|e| format!("Failed to write prompt.md: {e}"))?;
    std::fs::rename(&tmp_prompt, &local_prompt_path)
        .map_err(|e| format!("Failed to save prompt.md: {e}"))?;

    // 5. Push agent.json to GitHub
    let gh_base = format!("projects/{}/agents/{}", project, id);

    // Push agent.json
    {
        let gh_path = format!("{}/agent.json", gh_base);
        let gh_url = format!(
            "https://api.github.com/repos/{}/{}/contents/{}",
            owner, REPO_NAME, gh_path
        );

        // Check for existing SHA
        let existing_sha = {
            let check = state
                .http_client
                .get(&gh_url)
                .header("Authorization", format!("Bearer {}", pat))
                .header("User-Agent", "cthulu-studio")
                .header("Accept", "application/vnd.github+json")
                .send()
                .await;
            match check {
                Ok(resp) if resp.status().is_success() => {
                    let body: Value = resp.json().await.unwrap_or_default();
                    body["sha"].as_str().map(String::from)
                }
                _ => None,
            }
        };

        let encoded = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            agent_json_str.as_bytes(),
        );

        let mut body = json!({
            "message": format!("Publish agent: {}", id),
            "content": encoded,
        });
        if let Some(sha) = existing_sha {
            body["sha"] = json!(sha);
        }

        let resp = state
            .http_client
            .put(&gh_url)
            .header("Authorization", format!("Bearer {}", pat))
            .header("User-Agent", "cthulu-studio")
            .header("Accept", "application/vnd.github+json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("GitHub PUT agent.json error: {e}"))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("GitHub PUT agent.json error: {body}"));
        }
    }

    // Push prompt.md
    {
        let gh_path = format!("{}/prompt.md", gh_base);
        let gh_url = format!(
            "https://api.github.com/repos/{}/{}/contents/{}",
            owner, REPO_NAME, gh_path
        );

        let existing_sha = {
            let check = state
                .http_client
                .get(&gh_url)
                .header("Authorization", format!("Bearer {}", pat))
                .header("User-Agent", "cthulu-studio")
                .header("Accept", "application/vnd.github+json")
                .send()
                .await;
            match check {
                Ok(resp) if resp.status().is_success() => {
                    let body: Value = resp.json().await.unwrap_or_default();
                    body["sha"].as_str().map(String::from)
                }
                _ => None,
            }
        };

        let encoded = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            prompt_content.as_bytes(),
        );

        let mut body = json!({
            "message": format!("Publish agent prompt: {}", id),
            "content": encoded,
        });
        if let Some(sha) = existing_sha {
            body["sha"] = json!(sha);
        }

        let resp = state
            .http_client
            .put(&gh_url)
            .header("Authorization", format!("Bearer {}", pat))
            .header("User-Agent", "cthulu-studio")
            .header("Accept", "application/vnd.github+json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("GitHub PUT prompt.md error: {e}"))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("GitHub PUT prompt.md error: {body}"));
        }
    }

    Ok(json!({ "ok": true, "id": id, "project": project }))
}
```

- [ ] **Step 6: Add `unpublish_agent` command**

Append to `agent_repo.rs`:

```rust
#[tauri::command]
pub async fn unpublish_agent(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    id: String,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;
    let pat = require_pat(&state).await?;
    let owner = read_owner(&state)
        .ok_or_else(|| "Agent repo not set up".to_string())?;

    // 1. Get agent to find its project
    let mut agent = state
        .agent_repo
        .get(&id)
        .await
        .ok_or_else(|| "Agent not found".to_string())?;

    let project = agent.project.clone()
        .ok_or_else(|| "Agent is not published to any project".to_string())?;

    // 2. Delete from GitHub (agent.json and prompt.md)
    for filename in &["agent.json", "prompt.md"] {
        let gh_path = format!("projects/{}/agents/{}/{}", project, id, filename);
        let gh_url = format!(
            "https://api.github.com/repos/{}/{}/contents/{}",
            owner, REPO_NAME, gh_path
        );

        // Get SHA first
        let sha = {
            let check = state
                .http_client
                .get(&gh_url)
                .header("Authorization", format!("Bearer {}", pat))
                .header("User-Agent", "cthulu-studio")
                .header("Accept", "application/vnd.github+json")
                .send()
                .await;
            match check {
                Ok(resp) if resp.status().is_success() => {
                    let body: Value = resp.json().await.unwrap_or_default();
                    body["sha"].as_str().map(String::from)
                }
                _ => continue, // File doesn't exist, skip
            }
        };

        if let Some(sha) = sha {
            let body = json!({
                "message": format!("Unpublish agent: {}", id),
                "sha": sha,
            });

            let resp = state
                .http_client
                .delete(&gh_url)
                .header("Authorization", format!("Bearer {}", pat))
                .header("User-Agent", "cthulu-studio")
                .header("Accept", "application/vnd.github+json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("GitHub DELETE error: {e}"))?;

            if !resp.status().is_success() && resp.status() != reqwest::StatusCode::NOT_FOUND {
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("GitHub DELETE error: {body}"));
            }
        }
    }

    // 3. Delete from local sync directory
    let clone_path = clone_dir(&state);
    let agent_dir = clone_path.join("projects").join(&project).join("agents").join(&id);
    if agent_dir.exists() {
        let _ = std::fs::remove_dir_all(&agent_dir);
    }

    // 4. Clear project field on local agent
    agent.project = None;
    agent.updated_at = chrono::Utc::now();
    state.agent_repo.save(agent).await
        .map_err(|e| format!("Failed to update agent: {e}"))?;

    Ok(json!({ "ok": true, "id": id }))
}
```

- [ ] **Step 7: Add `sync_agent_repo` command**

Append to `agent_repo.rs`:

```rust
#[tauri::command]
pub async fn sync_agent_repo(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;
    let pat = require_pat(&state).await?;
    let owner = read_owner(&state)
        .ok_or_else(|| "Agent repo not set up. Run setup first.".to_string())?;

    let clone_path = clone_dir(&state);
    if !clone_path.exists() {
        std::fs::create_dir_all(&clone_path)
            .map_err(|e| format!("Failed to create sync directory: {e}"))?;
    }

    // 1. Recursively fetch repo contents from GitHub
    let projects_url = format!(
        "https://api.github.com/repos/{}/{}/contents/projects",
        owner, REPO_NAME
    );

    let projects_resp = state
        .http_client
        .get(&projects_url)
        .header("Authorization", format!("Bearer {}", pat))
        .header("User-Agent", "cthulu-studio")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("GitHub API error: {e}"))?;

    if projects_resp.status() == reqwest::StatusCode::NOT_FOUND {
        // No projects directory yet — empty repo
        return Ok(json!({ "ok": true, "synced": 0 }));
    }

    if !projects_resp.status().is_success() {
        let body = projects_resp.text().await.unwrap_or_default();
        return Err(format!("GitHub API error: {body}"));
    }

    let projects: Vec<Value> = projects_resp.json().await
        .map_err(|e| format!("Failed to parse projects: {e}"))?;

    let mut synced_count = 0u32;

    for project_entry in &projects {
        let project_name = match project_entry["name"].as_str() {
            Some(n) => n,
            None => continue,
        };
        if project_entry["type"].as_str() != Some("dir") {
            continue;
        }

        // List agents in this project
        let agents_url = format!(
            "https://api.github.com/repos/{}/{}/contents/projects/{}/agents",
            owner, REPO_NAME, project_name
        );

        let agents_resp = state
            .http_client
            .get(&agents_url)
            .header("Authorization", format!("Bearer {}", pat))
            .header("User-Agent", "cthulu-studio")
            .header("Accept", "application/vnd.github+json")
            .send()
            .await;

        let agent_dirs: Vec<Value> = match agents_resp {
            Ok(resp) if resp.status().is_success() => {
                resp.json().await.unwrap_or_default()
            }
            _ => continue,
        };

        for agent_entry in &agent_dirs {
            let agent_id = match agent_entry["name"].as_str() {
                Some(n) => n,
                None => continue,
            };
            if agent_entry["type"].as_str() != Some("dir") {
                continue;
            }

            // Fetch agent.json
            let agent_json_url = format!(
                "https://api.github.com/repos/{}/{}/contents/projects/{}/agents/{}/agent.json",
                owner, REPO_NAME, project_name, agent_id
            );
            let agent_json_resp = state
                .http_client
                .get(&agent_json_url)
                .header("Authorization", format!("Bearer {}", pat))
                .header("User-Agent", "cthulu-studio")
                .header("Accept", "application/vnd.github+json")
                .send()
                .await;

            let agent_json_content = match agent_json_resp {
                Ok(resp) if resp.status().is_success() => {
                    let file_info: Value = resp.json().await.unwrap_or_default();
                    match file_info["content"].as_str() {
                        Some(b64) => {
                            let cleaned = b64.replace('\n', "");
                            base64::Engine::decode(
                                &base64::engine::general_purpose::STANDARD,
                                &cleaned,
                            )
                            .ok()
                            .and_then(|bytes| String::from_utf8(bytes).ok())
                        }
                        None => None,
                    }
                }
                _ => None,
            };

            let agent_json_str = match agent_json_content {
                Some(s) => s,
                None => continue, // Skip agents without agent.json
            };

            // Fetch prompt.md
            let prompt_url = format!(
                "https://api.github.com/repos/{}/{}/contents/projects/{}/agents/{}/prompt.md",
                owner, REPO_NAME, project_name, agent_id
            );
            let prompt_resp = state
                .http_client
                .get(&prompt_url)
                .header("Authorization", format!("Bearer {}", pat))
                .header("User-Agent", "cthulu-studio")
                .header("Accept", "application/vnd.github+json")
                .send()
                .await;

            let prompt_content = match prompt_resp {
                Ok(resp) if resp.status().is_success() => {
                    let file_info: Value = resp.json().await.unwrap_or_default();
                    match file_info["content"].as_str() {
                        Some(b64) => {
                            let cleaned = b64.replace('\n', "");
                            base64::Engine::decode(
                                &base64::engine::general_purpose::STANDARD,
                                &cleaned,
                            )
                            .ok()
                            .and_then(|bytes| String::from_utf8(bytes).ok())
                        }
                        None => None,
                    }
                }
                _ => None,
            };

            let prompt = prompt_content.unwrap_or_default();

            // 2. Merge into runtime agent
            let mut agent_value: Value = serde_json::from_str(&agent_json_str)
                .map_err(|e| format!("Failed to parse agent.json for {}: {e}", agent_id))?;

            // Add prompt and project back
            if let Some(obj) = agent_value.as_object_mut() {
                obj.insert("prompt".to_string(), json!(prompt));
                obj.insert("project".to_string(), json!(project_name));
            }

            let agent: cthulu::agents::Agent = serde_json::from_value(agent_value)
                .map_err(|e| format!("Failed to deserialize agent {}: {e}", agent_id))?;

            // 3. Save to local sync directory
            let local_agent_dir = clone_path
                .join("projects")
                .join(project_name)
                .join("agents")
                .join(agent_id);
            let _ = std::fs::create_dir_all(&local_agent_dir);

            let local_json = local_agent_dir.join("agent.json");
            let tmp = local_json.with_extension("json.tmp");
            let _ = std::fs::write(&tmp, &agent_json_str);
            let _ = std::fs::rename(&tmp, &local_json);

            let local_prompt = local_agent_dir.join("prompt.md");
            let tmp = local_prompt.with_extension("md.tmp");
            let _ = std::fs::write(&tmp, &prompt);
            let _ = std::fs::rename(&tmp, &local_prompt);

            // 4. Save to runtime store
            state.agent_repo.save(agent).await
                .map_err(|e| format!("Failed to save agent {}: {e}", agent_id))?;

            synced_count += 1;
        }
    }

    // Reload all agents into memory
    state.agent_repo.load_all().await
        .map_err(|e| format!("Failed to reload agents: {e}"))?;

    Ok(json!({ "ok": true, "synced": synced_count }))
}
```

- [ ] **Step 8: Register module in `mod.rs`**

In `cthulu-studio/src-tauri/src/commands/mod.rs`, add:

```rust
pub mod agent_repo;
```

- [ ] **Step 9: Register commands in `main.rs`**

In `cthulu-studio/src-tauri/src/main.rs`, add to the `generate_handler![]` block after the `// Agents` section:

```rust
            // Agent Repo Sync
            commands::agent_repo::setup_agent_repo,
            commands::agent_repo::list_agent_projects,
            commands::agent_repo::create_agent_project,
            commands::agent_repo::publish_agent,
            commands::agent_repo::unpublish_agent,
            commands::agent_repo::sync_agent_repo,
```

- [ ] **Step 10: Run cargo check**

Run: `cargo check`
Expected: Compiles successfully. Fix any import issues (the `use` statements at the top of `agent_repo.rs` may need adjustment based on how `AppState` is imported — match the pattern in `workflows.rs`).

- [ ] **Step 11: Commit**

```bash
git add cthulu-studio/src-tauri/src/commands/agent_repo.rs
git add cthulu-studio/src-tauri/src/commands/mod.rs
git add cthulu-studio/src-tauri/src/main.rs
git commit -m "feat: add agent repo sync Tauri commands (setup, publish, sync, unpublish)"
```

---

## Chunk 2: Frontend API + UI

### Task 4: Add TypeScript types for `project` field

**Files:**
- Modify: `cthulu-studio/src/types/flow.ts:130-156`

- [ ] **Step 1: Add `project` to `Agent` interface**

In `cthulu-studio/src/types/flow.ts`, add after `working_dir: string | null;` in the `Agent` interface (around line 138):

```typescript
  project?: string | null;
```

- [ ] **Step 2: Add `project` to `AgentSummary` interface**

In the `AgentSummary` interface, add after `updated_at: string;` (around line 155):

```typescript
  project?: string | null;
```

- [ ] **Step 3: Commit**

```bash
git add cthulu-studio/src/types/flow.ts
git commit -m "feat: add project field to Agent and AgentSummary TypeScript interfaces"
```

---

### Task 5: Add frontend API functions

**Files:**
- Modify: `cthulu-studio/src/api/client.ts`

- [ ] **Step 1: Add agent repo sync functions to `client.ts`**

Add at the end of `client.ts` (before the closing of the file), after the existing workflow functions:

```typescript
// ── Agent Repo Sync ──────────────────────────────────────────────────

export async function setupAgentRepo(): Promise<{
  repo_url: string;
  created: boolean;
  username: string;
}> {
  log("http", "invoke setup_agent_repo");
  return invoke<{ repo_url: string; created: boolean; username: string }>(
    "setup_agent_repo"
  );
}

export async function listAgentProjects(): Promise<string[]> {
  log("http", "invoke list_agent_projects");
  const data = await invoke<{ projects: string[] }>("list_agent_projects");
  return data.projects;
}

export async function createAgentProject(
  project: string
): Promise<{ ok: boolean; project: string }> {
  log("http", `invoke create_agent_project project=${project}`);
  return invoke<{ ok: boolean; project: string }>("create_agent_project", {
    project,
  });
}

export async function publishAgent(
  id: string,
  project: string
): Promise<{ ok: boolean; id: string; project: string }> {
  log("http", `invoke publish_agent id=${id} project=${project}`);
  return invoke<{ ok: boolean; id: string; project: string }>(
    "publish_agent",
    { id, project }
  );
}

export async function unpublishAgent(
  id: string
): Promise<{ ok: boolean; id: string }> {
  log("http", `invoke unpublish_agent id=${id}`);
  return invoke<{ ok: boolean; id: string }>("unpublish_agent", { id });
}

export async function syncAgentRepo(): Promise<{
  ok: boolean;
  synced: number;
}> {
  log("http", "invoke sync_agent_repo");
  return invoke<{ ok: boolean; synced: number }>("sync_agent_repo");
}
```

- [ ] **Step 2: Run frontend build**

Run: `npx nx build cthulu-studio`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add cthulu-studio/src/api/client.ts
git commit -m "feat: add agent repo sync API functions to client.ts"
```

---

### Task 6: Add project selector and publish button to AgentEditor

**Files:**
- Modify: `cthulu-studio/src/components/AgentEditor.tsx`

- [ ] **Step 1: Add imports**

In `AgentEditor.tsx`, update the import from `client.ts` (line 3):

```typescript
import { getAgent, updateAgent, deleteAgent, wakeupAgent, listAgentProjects, createAgentProject, publishAgent, unpublishAgent, setupAgentRepo, getGithubPatStatus } from "../api/client";
```

- [ ] **Step 2: Add state for projects, publishing, and setup**

After the existing state declarations (around line 22), add:

```typescript
  const [projects, setProjects] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);
  const [repoConfigured, setRepoConfigured] = useState(false);
```

- [ ] **Step 3: Add effect to load projects and check repo status**

After the existing `useEffect` for agent loading (around line 42), add:

```typescript
  useEffect(() => {
    let cancelled = false;
    async function loadProjects() {
      try {
        const status = await getGithubPatStatus();
        if (!cancelled) setRepoConfigured(status.configured);
        if (status.configured) {
          const p = await listAgentProjects();
          if (!cancelled) setProjects(p);
        }
      } catch {
        // Ignore — projects are optional
      }
    }
    loadProjects();
    return () => { cancelled = true; };
  }, []);
```

- [ ] **Step 4: Add publish handler**

After the existing handlers (around line 100), add:

```typescript
  const handlePublish = useCallback(async () => {
    if (!agent || !agent.project) return;
    setPublishing(true);
    try {
      if (!repoConfigured) {
        await setupAgentRepo();
        setRepoConfigured(true);
      }
      await publishAgent(agent.id, agent.project);
    } catch (e) {
      const msg = typeof e === "string" ? e : (e instanceof Error ? e.message : String(e));
      console.error("Publish failed:", msg);
    } finally {
      setPublishing(false);
    }
  }, [agent, repoConfigured]);

  const handleCreateProject = useCallback(async () => {
    const name = newProjectName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (!name) return;
    try {
      await createAgentProject(name);
      setProjects(prev => [...prev, name].sort());
      if (agent) {
        handleChange("project", name);
      }
      setShowNewProject(false);
      setNewProjectName("");
    } catch (e) {
      const msg = typeof e === "string" ? e : (e instanceof Error ? e.message : String(e));
      console.error("Create project failed:", msg);
    }
  }, [newProjectName, agent, handleChange]);
```

- [ ] **Step 5: Add project selector and publish button to the JSX**

In the main return, after the header section (around line 152), add a new section before the Name field:

```tsx
            {/* Project & Publish */}
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.75rem" }}>
              <label style={{ fontSize: "0.75rem", color: "var(--text-secondary)", minWidth: 50 }}>
                Project
              </label>
              <select
                value={agent?.project || ""}
                onChange={(e) => {
                  if (e.target.value === "__new__") {
                    setShowNewProject(true);
                  } else {
                    handleChange("project", e.target.value || null);
                  }
                }}
                style={{
                  flex: 1,
                  padding: "0.25rem 0.5rem",
                  fontSize: "0.8rem",
                  background: "var(--bg-secondary)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  color: "var(--text)",
                }}
              >
                <option value="">Local only</option>
                {projects.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
                <option value="__new__">+ New project...</option>
              </select>
              <Button
                size="sm"
                onClick={handlePublish}
                disabled={!agent?.project || publishing}
                style={{ fontSize: "0.75rem" }}
              >
                {publishing ? "Publishing..." : "Publish"}
              </Button>
            </div>

            {showNewProject && (
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.75rem" }}>
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="project-name"
                  style={{
                    flex: 1,
                    padding: "0.25rem 0.5rem",
                    fontSize: "0.8rem",
                    background: "var(--bg-secondary)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    color: "var(--text)",
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateProject();
                    if (e.key === "Escape") { setShowNewProject(false); setNewProjectName(""); }
                  }}
                />
                <Button size="sm" onClick={handleCreateProject} style={{ fontSize: "0.75rem" }}>
                  Create
                </Button>
                <button
                  className="ghost"
                  onClick={() => { setShowNewProject(false); setNewProjectName(""); }}
                  style={{ fontSize: "0.75rem", padding: "0.25rem" }}
                >
                  Cancel
                </button>
              </div>
            )}
```

- [ ] **Step 6: Update `handleChange` to support `project` field**

The existing `handleChange` function calls `debouncedSave`. The `debouncedSave` function calls `updateAgent` with specific fields. Verify that `project` is included in the `updateAgent` call. If it uses a spread of the agent object, it should work automatically. If it cherry-picks fields, add `project: agent.project`.

Check `debouncedSave` — it builds an updates object. Add:

```typescript
project: agent.project,
```

to the updates object passed to `updateAgent()`.

- [ ] **Step 7: Update `UpdateAgentRequest` in Rust to include `project`**

In `cthulu-studio/src-tauri/src/commands/agents.rs`, add to the `UpdateAgentRequest` struct (around line 128):

```rust
    #[serde(default)]
    project: Option<Option<String>>,
```

And in the `update_agent` function body, add after the existing field updates:

```rust
    if let Some(project) = request.project { agent.project = project; }
```

- [ ] **Step 8: Run both builds**

Run: `cargo check && npx nx build cthulu-studio`
Expected: Both succeed

- [ ] **Step 9: Commit**

```bash
git add cthulu-studio/src/components/AgentEditor.tsx
git add cthulu-studio/src-tauri/src/commands/agents.rs
git commit -m "feat: add project selector and publish button to agent editor"
```

---

### Task 7: Group agents by project in Sidebar

**Files:**
- Modify: `cthulu-studio/src/components/Sidebar.tsx:335-442`

- [ ] **Step 1: Add sync button and project grouping logic**

In `Sidebar.tsx`, add the `syncAgentRepo` import:

```typescript
import { syncAgentRepo } from "../api/client";
```

- [ ] **Step 2: Add sync state and handler**

In the Sidebar component, add state:

```typescript
const [syncing, setSyncing] = useState(false);
```

Add handler:

```typescript
const handleSyncAgents = useCallback(async () => {
  setSyncing(true);
  try {
    await syncAgentRepo();
    refreshAgents();
  } catch (e) {
    console.error("Sync failed:", e);
  } finally {
    setSyncing(false);
  }
}, [refreshAgents]);
```

- [ ] **Step 3: Add sync button to agents section header**

In the agents section header (around line 342), add a sync button before the "+" button:

```tsx
            <button
              className="ghost sidebar-action-btn"
              onClick={(e) => { e.stopPropagation(); handleSyncAgents(); }}
              aria-label="Sync agents"
              disabled={syncing}
              title="Sync agents from GitHub"
            >
              {syncing ? "..." : "↓"}
            </button>
```

- [ ] **Step 4: Group agents by project in the render**

Replace the flat agent list rendering with project grouping. Before the `.map()` call (around line 355), compute groups:

```typescript
            {(() => {
              const sorted = [...agents].sort((a, b) => {
                if (a.id === STUDIO_ASSISTANT_ID) return -1;
                if (b.id === STUDIO_ASSISTANT_ID) return 1;
                return 0;
              });

              const grouped = new Map<string, typeof agents>();
              const localOnly: typeof agents = [];

              for (const agent of sorted) {
                if (agent.project) {
                  const group = grouped.get(agent.project) ?? [];
                  group.push(agent);
                  grouped.set(agent.project, group);
                } else {
                  localOnly.push(agent);
                }
              }

              return (
                <>
                  {[...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([project, projectAgents]) => (
                    <div key={project} className="sb-project-group">
                      <div className="sb-project-header">
                        <span style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-secondary)" }}>
                          {project}
                        </span>
                      </div>
                      {projectAgents.map((agent) => {
                        /* existing agent row rendering */
                        const meta = agentMeta.get(agent.id);
                        const isExpanded = expandedAgents.has(agent.id);
                        const isActive = agent.id === selectedAgentId && activeView === "agent-workspace";
                        const sessions = meta?.sessions ?? [];
                        return (
                          <div key={agent.id} className="sb-agent">
                            {/* ... existing agent row JSX ... */}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {localOnly.length > 0 && grouped.size > 0 && (
                    <div className="sb-project-group">
                      <div className="sb-project-header">
                        <span style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-secondary)" }}>
                          Local Only
                        </span>
                      </div>
                      {localOnly.map((agent) => {
                        /* same agent row rendering */
                      })}
                    </div>
                  )}
                  {localOnly.length > 0 && grouped.size === 0 && (
                    <>
                      {localOnly.map((agent) => {
                        /* same agent row rendering, no header */
                      })}
                    </>
                  )}
                </>
              );
            })()}
```

**Note:** The inner agent row JSX (`<div className="sb-agent">...`) is the exact same as the existing rendering — just copy it into each branch. The only change is wrapping with project group headers.

- [ ] **Step 5: Add CSS for project groups**

In `cthulu-studio/src/styles.css`, add:

```css
.sb-project-group {
  margin-bottom: 0.25rem;
}
.sb-project-header {
  padding: 0.25rem 1rem;
  user-select: none;
}
```

- [ ] **Step 6: Run frontend build**

Run: `npx nx build cthulu-studio`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add cthulu-studio/src/components/Sidebar.tsx
git add cthulu-studio/src/styles.css
git commit -m "feat: group agents by project in sidebar with sync button"
```

---

### Task 8: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run cargo check**

Run: `cargo check`
Expected: No errors

- [ ] **Step 2: Run frontend build**

Run: `npx nx build cthulu-studio`
Expected: No errors

- [ ] **Step 3: Test in dev mode**

Run: `npx nx dev cthulu-studio` (from `cthulu/` directory)

Manual test checklist:
1. Open Agents tab — agents display correctly (flat if no projects, grouped if projects exist)
2. Open agent editor — project selector dropdown visible
3. Select "Local only" — publish button disabled
4. Create a new project via "+" — verify input and creation
5. Select the project — publish button enabled
6. Click Publish — verify it completes (requires GitHub PAT configured)
7. Click Sync in sidebar — verify it pulls agents

- [ ] **Step 4: Commit any fixes**

If any fixes were needed during testing, commit them.
