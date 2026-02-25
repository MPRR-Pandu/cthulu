use axum::extract::State;
use axum::Json;
use hyper::StatusCode;
use serde_json::{json, Value};

use super::super::AppState;

/// GET /api/sandbox/info — provider info and capabilities.
pub(crate) async fn sandbox_info(State(state): State<AppState>) -> Json<Value> {
    let info = state.sandbox_provider.info();
    Json(json!({
        "provider": format!("{:?}", info.kind),
        "supports_persistent_state": info.supports_persistent_state,
        "supports_checkpoint": info.supports_checkpoint,
        "supports_public_http": info.supports_public_http,
        "supports_sleep_resume": info.supports_sleep_resume,
    }))
}

/// GET /api/sandbox/list — list active sandboxes.
pub(crate) async fn sandbox_list(State(state): State<AppState>) -> Result<Json<Value>, StatusCode> {
    match state.sandbox_provider.list().await {
        Ok(sandboxes) => {
            let items: Vec<Value> = sandboxes
                .iter()
                .map(|s| {
                    json!({
                        "id": s.id,
                        "backend": format!("{:?}", s.backend),
                        "status": format!("{:?}", s.status),
                        "workspace_id": s.workspace_id,
                    })
                })
                .collect();
            Ok(Json(json!({ "sandboxes": items })))
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to list sandboxes");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}
