pub mod middleware;
pub mod slices;

use axum::body::Body;
use axum::extract::Request;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use hyper::StatusCode;
use reqwest::Client;
use serde_json::json;
use std::sync::Arc;

use crate::app::middleware::enrich_current_span::enrich_current_span_middleware;
use crate::app::middleware::strip_trailing_slash::strip_trailing_slash;

#[derive(Clone)]
pub struct AppState {
    pub http_client: Arc<Client>,
}

async fn not_found(req: Request<Body>) -> impl IntoResponse {
    tracing::warn!("unhandled path: {}", req.uri());
    (StatusCode::NOT_FOUND, "Not Found")
}

pub fn create_app(state: AppState) -> Router {
    let health_routes = Router::new().route(
        "/",
        get(|| async {
            Json(json!({
                "status": "ok",
            }))
        }),
    );

    let claude_routes = slices::claude::routes::routes();

    Router::new()
        .nest("/health", health_routes)
        .nest("/claude", claude_routes)
        .fallback(not_found)
        .with_state(state)
        .layer(axum::middleware::from_fn(strip_trailing_slash))
        .layer(axum::middleware::from_fn(enrich_current_span_middleware))
}
