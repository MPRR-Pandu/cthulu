pub mod middleware;
pub mod routes;

use axum::Router;

use crate::tasks::TaskState;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub http_client: Arc<reqwest::Client>,
    pub task_state: Arc<TaskState>,
    pub config: Arc<crate::config::Config>,
}

pub fn create_app(state: AppState) -> Router {
    routes::build_router(state)
}
