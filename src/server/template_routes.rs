/// REST endpoints for the template gallery.
///
/// GET  /api/templates                         — list all templates (metadata + raw YAML)
/// GET  /api/templates/{cat}/{slug}             — get raw YAML for a single template
/// POST /api/templates/{cat}/{slug}/import      — parse YAML → Flow, save, return Flow
/// POST /api/templates/import-yaml             — parse raw YAML body → Flow, save, return Flow
/// POST /api/templates/import-github           — fetch all workflow YAMLs from a GitHub repo,
///                                               import each one, return array of imported Flows
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use super::AppState;
use crate::templates;

pub fn template_router() -> Router<AppState> {
    Router::new()
        .route("/templates", get(list_templates))
        .route("/templates/import-yaml", post(import_yaml))
        .route("/templates/import-github", post(import_github))
        .route("/templates/{category}/{slug}", get(get_template_yaml))
        .route("/templates/{category}/{slug}/import", post(import_template))
}

/// List all templates across all categories.
/// Returns an array of `TemplateMetadata` objects.
async fn list_templates(State(state): State<AppState>) -> impl IntoResponse {
    let templates = templates::load_templates(&state.static_dir);
    Json(json!({ "templates": templates }))
}

/// Return the raw YAML for a single template.
async fn get_template_yaml(
    State(state): State<AppState>,
    Path((category, slug)): Path<(String, String)>,
) -> impl IntoResponse {
    let file_path = state
        .static_dir
        .join("workflows")
        .join(&category)
        .join(format!("{slug}.yaml"));

    match std::fs::read_to_string(&file_path) {
        Ok(yaml) => (
            StatusCode::OK,
            [("content-type", "text/yaml; charset=utf-8")],
            yaml,
        )
            .into_response(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (
            StatusCode::NOT_FOUND,
            [("content-type", "application/json")],
            json!({ "error": format!("template not found: {category}/{slug}") }).to_string(),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            [("content-type", "application/json")],
            json!({ "error": e.to_string() }).to_string(),
        )
            .into_response(),
    }
}

/// Parse the template YAML into a Flow, persist it, and return the new Flow.
/// The imported flow is always set to `enabled: false` (safe default).
async fn import_template(
    State(state): State<AppState>,
    Path((category, slug)): Path<(String, String)>,
) -> impl IntoResponse {
    let file_path = state
        .static_dir
        .join("workflows")
        .join(&category)
        .join(format!("{slug}.yaml"));

    let yaml = match std::fs::read_to_string(&file_path) {
        Ok(y) => y,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("template not found: {category}/{slug}") })),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };

    let flow = match templates::parse_template_yaml(&yaml) {
        Ok(f) => f,
        Err(e) => {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(json!({ "error": format!("failed to parse template: {e}") })),
            )
                .into_response();
        }
    };

    match state.store.save_flow(flow.clone()).await {
        Ok(_) => {
            // Start scheduler for the new flow (it's disabled, but register it)
            let _ = state.scheduler.restart_flow(&flow.id).await;
            tracing::info!(
                flow_id = %flow.id,
                flow_name = %flow.name,
                template = %format!("{category}/{slug}"),
                "imported template as new flow"
            );
            Json(json!(flow)).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("failed to save flow: {e}") })),
        )
            .into_response(),
    }
}

// ── Body types ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ImportYamlBody {
    /// Raw YAML content of the workflow file.
    yaml: String,
}

#[derive(Deserialize)]
struct ImportGithubBody {
    /// GitHub repo URL, e.g. "https://github.com/owner/repo" or
    /// "https://github.com/owner/repo/tree/main/workflows".
    /// We normalise to the GitHub Contents API automatically.
    repo_url: String,
    /// Optional sub-path within the repo to scan for YAML files (default: root).
    #[serde(default)]
    path: String,
    /// Optional branch/tag/sha (default: "main").
    #[serde(default)]
    branch: String,
}

// ── Handlers ───────────────────────────────────────────────────────────────

/// POST /api/templates/import-yaml
/// Body: `{ "yaml": "<raw YAML string>" }`
/// Parses the YAML as a workflow, saves it as a new disabled Flow, returns the Flow.
async fn import_yaml(
    State(state): State<AppState>,
    Json(body): Json<ImportYamlBody>,
) -> impl IntoResponse {
    if body.yaml.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "yaml field is required and must not be empty" })),
        )
            .into_response();
    }

    let flow = match templates::parse_template_yaml(&body.yaml) {
        Ok(f) => f,
        Err(e) => {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(json!({ "error": format!("failed to parse YAML: {e}") })),
            )
                .into_response();
        }
    };

    match state.store.save_flow(flow.clone()).await {
        Ok(_) => {
            let _ = state.scheduler.restart_flow(&flow.id).await;
            tracing::info!(flow_id = %flow.id, flow_name = %flow.name, "imported flow from uploaded YAML");
            Json(json!({ "flows": [flow] })).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("failed to save flow: {e}") })),
        )
            .into_response(),
    }
}

/// POST /api/templates/import-github
/// Body: `{ "repo_url": "https://github.com/owner/repo", "path": "", "branch": "main" }`
///
/// Uses the GitHub Contents API (no auth required for public repos) to list files,
/// then fetches every `.yaml` / `.yml` file and imports each as a new disabled Flow.
/// Returns `{ "flows": [...], "errors": [...] }`.
async fn import_github(
    State(state): State<AppState>,
    Json(body): Json<ImportGithubBody>,
) -> impl IntoResponse {
    let branch = if body.branch.is_empty() { "main".to_string() } else { body.branch.clone() };

    // Parse the GitHub URL into (owner, repo, sub_path).
    // Accepted formats:
    //   https://github.com/owner/repo
    //   https://github.com/owner/repo/tree/branch/path/to/dir
    //   github.com/owner/repo
    let url = body.repo_url.trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("github.com/")
        .trim_end_matches('/');

    let parts: Vec<&str> = url.splitn(5, '/').collect();
    if parts.len() < 2 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid GitHub URL — expected https://github.com/owner/repo" })),
        ).into_response();
    }

    let owner = parts[0];
    let repo = parts[1];

    // If the URL contains /tree/branch/sub_path, extract sub_path
    let url_sub_path = if parts.len() >= 5 && parts[2] == "tree" {
        parts[4].to_string() // e.g. "workflows"
    } else {
        String::new()
    };

    let sub_path = if !body.path.is_empty() {
        body.path.trim_matches('/').to_string()
    } else {
        url_sub_path
    };

    // Recursively fetch all YAML files from the GitHub Contents API
    let yaml_files = match fetch_github_yaml_files(
        &state.http_client,
        owner,
        repo,
        &sub_path,
        &branch,
    ).await {
        Ok(files) => files,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("failed to fetch GitHub repo: {e}") })),
            ).into_response();
        }
    };

    if yaml_files.is_empty() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no .yaml or .yml files found in the specified path" })),
        ).into_response();
    }

    let mut imported_flows: Vec<serde_json::Value> = Vec::new();
    let mut errors: Vec<serde_json::Value> = Vec::new();

    for (filename, yaml_content) in &yaml_files {
        match templates::parse_template_yaml(yaml_content) {
            Ok(flow) => {
                match state.store.save_flow(flow.clone()).await {
                    Ok(_) => {
                        let _ = state.scheduler.restart_flow(&flow.id).await;
                        tracing::info!(
                            flow_id = %flow.id,
                            flow_name = %flow.name,
                            file = %filename,
                            "imported flow from GitHub"
                        );
                        imported_flows.push(json!(flow));
                    }
                    Err(e) => {
                        errors.push(json!({ "file": filename, "error": format!("save failed: {e}") }));
                    }
                }
            }
            Err(e) => {
                errors.push(json!({ "file": filename, "error": format!("parse failed: {e}") }));
            }
        }
    }

    Json(json!({
        "flows": imported_flows,
        "errors": errors,
        "total_found": yaml_files.len(),
        "imported": imported_flows.len(),
    })).into_response()
}

/// Fetch all `.yaml` / `.yml` files from a GitHub repo path using the Contents API.
/// Recurses into subdirectories up to 2 levels deep.
/// Returns `Vec<(filename, yaml_content)>`.
async fn fetch_github_yaml_files(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    path: &str,
    branch: &str,
) -> Result<Vec<(String, String)>, String> {
    let api_url = if path.is_empty() {
        format!("https://api.github.com/repos/{owner}/{repo}/contents?ref={branch}")
    } else {
        format!("https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={branch}")
    };

    let resp = client
        .get(&api_url)
        .header("User-Agent", "cthulu-studio/1.0")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| format!("GitHub API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("GitHub API returned {status}: {body}"));
    }

    let entries: Vec<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| format!("failed to parse GitHub API response: {e}"))?;

    let mut yaml_files: Vec<(String, String)> = Vec::new();

    for entry in &entries {
        let entry_type = entry["type"].as_str().unwrap_or("");
        let entry_name = entry["name"].as_str().unwrap_or("");
        let entry_path = entry["path"].as_str().unwrap_or("");
        let download_url = entry["download_url"].as_str().unwrap_or("");

        if entry_type == "file"
            && (entry_name.ends_with(".yaml") || entry_name.ends_with(".yml"))
        {
            match client
                .get(download_url)
                .header("User-Agent", "cthulu-studio/1.0")
                .send()
                .await
            {
                Ok(file_resp) if file_resp.status().is_success() => {
                    match file_resp.text().await {
                        Ok(content) => yaml_files.push((entry_name.to_string(), content)),
                        Err(e) => tracing::warn!(file = %entry_name, error = %e, "failed to read file content"),
                    }
                }
                Ok(r) => tracing::warn!(file = %entry_name, status = %r.status(), "non-200 fetching file"),
                Err(e) => tracing::warn!(file = %entry_name, error = %e, "failed to fetch file"),
            }
        } else if entry_type == "dir" {
            // Recurse one level into subdirectories
            match Box::pin(fetch_github_yaml_files(client, owner, repo, entry_path, branch)).await {
                Ok(sub_files) => yaml_files.extend(sub_files),
                Err(e) => tracing::warn!(dir = %entry_path, error = %e, "failed to recurse into directory"),
            }
        }
    }

    Ok(yaml_files)
}
