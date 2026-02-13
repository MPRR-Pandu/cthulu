use axum::routing::post;
use axum::Router;

use super::handlers::run_claude;
use crate::app::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/", post(run_claude))
}
