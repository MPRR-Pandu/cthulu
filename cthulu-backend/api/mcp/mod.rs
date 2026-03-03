pub mod handlers;

use axum::routing::{get, post};
use axum::Router;

use crate::api::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/mcp/status", get(handlers::mcp_status))
        .route("/mcp/build", post(handlers::mcp_build))
        .route("/mcp/register", post(handlers::mcp_register))
}
