use serde::Deserialize;
use serde_json::{json, Value};

use cthulu::api::AppState;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Read a key from secrets.json. Returns None if key doesn't exist or file doesn't exist.
fn read_secret(secrets_path: &std::path::Path, key: &str) -> Option<String> {
    let content = std::fs::read_to_string(secrets_path).ok()?;
    let secrets: Value = serde_json::from_str(&content).ok()?;
    secrets[key].as_str().map(|s| s.to_string()).filter(|s| !s.is_empty())
}

/// Save a single key to secrets.json atomically (temp file + rename).
fn save_secret(secrets_path: &std::path::Path, key: &str, value: &str) -> Result<(), String> {
    let mut secrets: Value = if secrets_path.exists() {
        let content = std::fs::read_to_string(secrets_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_else(|_| json!({}))
    } else {
        if let Some(parent) = secrets_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        json!({})
    };

    secrets[key] = json!(value);

    let tmp_path = secrets_path.with_extension("json.tmp");
    let json_str = serde_json::to_string_pretty(&secrets)
        .map_err(|e| format!("Failed to serialize secrets: {e}"))?;

    std::fs::write(&tmp_path, &json_str)
        .map_err(|e| format!("Failed to write secrets file: {e}"))?;

    std::fs::rename(&tmp_path, secrets_path)
        .map_err(|e| format!("Failed to save secrets file: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// AgentSyncPayload
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct AgentSyncPayload {
    pub name: String,
    pub system_prompt: String,
    pub tools: Vec<String>,
    pub model: String,
}

// ---------------------------------------------------------------------------
// 1. cloud_login
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cloud_login(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    cloud_url: String,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    let pat = read_secret(&state.secrets_path, "github_pat")
        .ok_or_else(|| "GitHub PAT not configured".to_string())?;
    let anthropic_key = read_secret(&state.secrets_path, "anthropic_api_key")
        .ok_or_else(|| "Anthropic API key not configured".to_string())?;

    let resp = state
        .http_client
        .post(format!("{}/api/auth/login", cloud_url))
        .json(&json!({
            "github_pat": pat,
            "anthropic_api_key": anthropic_key,
        }))
        .send()
        .await
        .map_err(|e| format!("Cloud API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cloud API error ({status}): {body}"));
    }

    let data: Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse cloud response: {e}"))?;

    // Save JWT to secrets.json
    if let Some(token) = data["token"].as_str() {
        save_secret(&state.secrets_path, "cloud_jwt", token)?;
    }

    Ok(data)
}

// ---------------------------------------------------------------------------
// 2. cloud_list_agents
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cloud_list_agents(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    cloud_url: String,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    let jwt = read_secret(&state.secrets_path, "cloud_jwt")
        .ok_or_else(|| "Not logged in to cloud — no JWT found".to_string())?;

    let resp = state
        .http_client
        .get(format!("{}/api/agents", cloud_url))
        .header("Authorization", format!("Bearer {jwt}"))
        .send()
        .await
        .map_err(|e| format!("Cloud API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cloud API error ({status}): {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse cloud response: {e}"))
}

// ---------------------------------------------------------------------------
// 3. cloud_sync_agent
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cloud_sync_agent(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    cloud_url: String,
    agent: AgentSyncPayload,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    let jwt = read_secret(&state.secrets_path, "cloud_jwt")
        .ok_or_else(|| "Not logged in to cloud — no JWT found".to_string())?;

    let resp = state
        .http_client
        .post(format!("{}/api/agents/sync", cloud_url))
        .header("Authorization", format!("Bearer {jwt}"))
        .json(&json!({
            "name": agent.name,
            "system_prompt": agent.system_prompt,
            "tools": agent.tools,
            "model": agent.model,
        }))
        .send()
        .await
        .map_err(|e| format!("Cloud API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cloud API error ({status}): {body}"));
    }

    Ok(json!({ "ok": true }))
}

// ---------------------------------------------------------------------------
// 4. cloud_submit_task
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cloud_submit_task(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    cloud_url: String,
    agent_name: String,
    message: String,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    let jwt = read_secret(&state.secrets_path, "cloud_jwt")
        .ok_or_else(|| "Not logged in to cloud — no JWT found".to_string())?;

    let resp = state
        .http_client
        .post(format!("{}/api/tasks", cloud_url))
        .header("Authorization", format!("Bearer {jwt}"))
        .json(&json!({
            "agent_name": agent_name,
            "message": message,
        }))
        .send()
        .await
        .map_err(|e| format!("Cloud API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cloud API error ({status}): {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse cloud response: {e}"))
}

// ---------------------------------------------------------------------------
// 5. cloud_list_tasks
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cloud_list_tasks(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    cloud_url: String,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    let jwt = read_secret(&state.secrets_path, "cloud_jwt")
        .ok_or_else(|| "Not logged in to cloud — no JWT found".to_string())?;

    let resp = state
        .http_client
        .get(format!("{}/api/tasks", cloud_url))
        .header("Authorization", format!("Bearer {jwt}"))
        .send()
        .await
        .map_err(|e| format!("Cloud API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cloud API error ({status}): {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse cloud response: {e}"))
}

// ---------------------------------------------------------------------------
// 6. cloud_get_task
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cloud_get_task(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    cloud_url: String,
    task_id: String,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    let jwt = read_secret(&state.secrets_path, "cloud_jwt")
        .ok_or_else(|| "Not logged in to cloud — no JWT found".to_string())?;

    let resp = state
        .http_client
        .get(format!("{}/api/tasks/{}", cloud_url, task_id))
        .header("Authorization", format!("Bearer {jwt}"))
        .send()
        .await
        .map_err(|e| format!("Cloud API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cloud API error ({status}): {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse cloud response: {e}"))
}

// ===========================================================================
// Cloud Workflow API Commands (9 commands)
// ===========================================================================

// ---------------------------------------------------------------------------
// 7. cloud_list_workflows
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cloud_list_workflows(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    cloud_url: String,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    let jwt = read_secret(&state.secrets_path, "cloud_jwt")
        .ok_or_else(|| "Not logged in to cloud — no JWT found".to_string())?;

    let resp = state
        .http_client
        .get(format!("{}/api/workflows", cloud_url))
        .header("Authorization", format!("Bearer {jwt}"))
        .send()
        .await
        .map_err(|e| format!("Cloud API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cloud API error ({status}): {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse cloud response: {e}"))
}

// ---------------------------------------------------------------------------
// 8. cloud_get_workflow
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cloud_get_workflow(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    cloud_url: String,
    workflow_id: String,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    let jwt = read_secret(&state.secrets_path, "cloud_jwt")
        .ok_or_else(|| "Not logged in to cloud — no JWT found".to_string())?;

    let resp = state
        .http_client
        .get(format!("{}/api/workflows/{}", cloud_url, workflow_id))
        .header("Authorization", format!("Bearer {jwt}"))
        .send()
        .await
        .map_err(|e| format!("Cloud API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cloud API error ({status}): {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse cloud response: {e}"))
}

// ---------------------------------------------------------------------------
// 9. cloud_create_workflow
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cloud_create_workflow(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    cloud_url: String,
    workflow: Value,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    let jwt = read_secret(&state.secrets_path, "cloud_jwt")
        .ok_or_else(|| "Not logged in to cloud — no JWT found".to_string())?;

    let resp = state
        .http_client
        .post(format!("{}/api/workflows", cloud_url))
        .header("Authorization", format!("Bearer {jwt}"))
        .json(&workflow)
        .send()
        .await
        .map_err(|e| format!("Cloud API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cloud API error ({status}): {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse cloud response: {e}"))
}

// ---------------------------------------------------------------------------
// 10. cloud_update_workflow
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cloud_update_workflow(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    cloud_url: String,
    workflow_id: String,
    updates: Value,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    let jwt = read_secret(&state.secrets_path, "cloud_jwt")
        .ok_or_else(|| "Not logged in to cloud — no JWT found".to_string())?;

    let resp = state
        .http_client
        .put(format!("{}/api/workflows/{}", cloud_url, workflow_id))
        .header("Authorization", format!("Bearer {jwt}"))
        .json(&updates)
        .send()
        .await
        .map_err(|e| format!("Cloud API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cloud API error ({status}): {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse cloud response: {e}"))
}

// ---------------------------------------------------------------------------
// 11. cloud_delete_workflow
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cloud_delete_workflow(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    cloud_url: String,
    workflow_id: String,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    let jwt = read_secret(&state.secrets_path, "cloud_jwt")
        .ok_or_else(|| "Not logged in to cloud — no JWT found".to_string())?;

    let resp = state
        .http_client
        .delete(format!("{}/api/workflows/{}", cloud_url, workflow_id))
        .header("Authorization", format!("Bearer {jwt}"))
        .send()
        .await
        .map_err(|e| format!("Cloud API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cloud API error ({status}): {body}"));
    }

    Ok(json!({ "ok": true }))
}

// ---------------------------------------------------------------------------
// 12. cloud_trigger_workflow
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cloud_trigger_workflow(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    cloud_url: String,
    workflow_id: String,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    let jwt = read_secret(&state.secrets_path, "cloud_jwt")
        .ok_or_else(|| "Not logged in to cloud — no JWT found".to_string())?;

    let resp = state
        .http_client
        .post(format!(
            "{}/api/workflows/{}/trigger",
            cloud_url, workflow_id
        ))
        .header("Authorization", format!("Bearer {jwt}"))
        .send()
        .await
        .map_err(|e| format!("Cloud API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cloud API error ({status}): {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse cloud response: {e}"))
}

// ---------------------------------------------------------------------------
// 13. cloud_enable_workflow
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cloud_enable_workflow(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    cloud_url: String,
    workflow_id: String,
    enabled: bool,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    let jwt = read_secret(&state.secrets_path, "cloud_jwt")
        .ok_or_else(|| "Not logged in to cloud — no JWT found".to_string())?;

    let resp = state
        .http_client
        .put(format!(
            "{}/api/workflows/{}/enable",
            cloud_url, workflow_id
        ))
        .header("Authorization", format!("Bearer {jwt}"))
        .json(&json!({ "enabled": enabled }))
        .send()
        .await
        .map_err(|e| format!("Cloud API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cloud API error ({status}): {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse cloud response: {e}"))
}

// ---------------------------------------------------------------------------
// 14. cloud_list_workflow_runs
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cloud_list_workflow_runs(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    cloud_url: String,
    workflow_id: String,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    let jwt = read_secret(&state.secrets_path, "cloud_jwt")
        .ok_or_else(|| "Not logged in to cloud — no JWT found".to_string())?;

    let resp = state
        .http_client
        .get(format!(
            "{}/api/workflows/{}/runs",
            cloud_url, workflow_id
        ))
        .header("Authorization", format!("Bearer {jwt}"))
        .send()
        .await
        .map_err(|e| format!("Cloud API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cloud API error ({status}): {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse cloud response: {e}"))
}

// ---------------------------------------------------------------------------
// 15. cloud_get_workflow_run
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cloud_get_workflow_run(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    cloud_url: String,
    workflow_id: String,
    run_id: String,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    let jwt = read_secret(&state.secrets_path, "cloud_jwt")
        .ok_or_else(|| "Not logged in to cloud — no JWT found".to_string())?;

    let resp = state
        .http_client
        .get(format!(
            "{}/api/workflows/{}/runs/{}",
            cloud_url, workflow_id, run_id
        ))
        .header("Authorization", format!("Bearer {jwt}"))
        .send()
        .await
        .map_err(|e| format!("Cloud API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cloud API error ({status}): {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse cloud response: {e}"))
}
