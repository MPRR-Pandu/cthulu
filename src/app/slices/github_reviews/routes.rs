use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use hyper::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::app::AppState;

use super::{github_client, handle_review};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/status", get(review_status))
        .route("/trigger", post(trigger_review))
}

#[derive(Deserialize)]
struct TriggerRequest {
    repo: String,
    pr: u64,
}

async fn trigger_review(
    State(state): State<AppState>,
    Json(body): Json<TriggerRequest>,
) -> (StatusCode, Json<Value>) {
    let review_state = &state.review_state;

    // Find matching repo config
    let repo_config = match review_state.repos.iter().find(|r| r.full_name() == body.repo) {
        Some(r) => r.clone(),
        None => {
            let known: Vec<String> = review_state.repos.iter().map(|r| r.full_name()).collect();
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": format!("unknown repo '{}', known repos: {:?}", body.repo, known)
                })),
            );
        }
    };

    let token = review_state.github_token.lock().await.clone();
    if token.is_empty() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "GITHUB_TOKEN not configured" })),
        );
    }

    let instructions = review_state.review_instructions.lock().await.clone();
    let client = state.http_client.clone();
    let pr_number = body.pr;

    // Fetch the PR from GitHub to get full metadata
    let pr = match github_client::fetch_single_pr(
        &client,
        &token,
        &repo_config.owner,
        &repo_config.repo,
        pr_number,
    )
    .await
    {
        Ok(pr) => pr,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("failed to fetch PR #{}: {}", pr_number, e) })),
            );
        }
    };

    // Mark as seen so the poller doesn't also review it
    {
        let mut seen = review_state.seen_prs.lock().await;
        seen.entry(repo_config.full_name()).or_default().insert(pr_number);
    }

    // Bump active count and spawn review
    let review_state_clone = state.review_state.clone();
    tokio::spawn(async move {
        {
            let mut active = review_state_clone.active_reviews.lock().await;
            *active += 1;
        }

        let result = handle_review(&client, &token, &repo_config, &pr, &instructions).await;

        {
            let mut active = review_state_clone.active_reviews.lock().await;
            *active -= 1;
        }

        match result {
            Ok(()) => {
                let mut completed = review_state_clone.reviews_completed.lock().await;
                *completed += 1;
                tracing::info!(
                    repo = %repo_config.full_name(),
                    pr = pr_number,
                    "Manual review posted for PR #{}",
                    pr_number
                );
            }
            Err(e) => {
                tracing::error!(
                    repo = %repo_config.full_name(),
                    pr = pr_number,
                    error = %e,
                    "Manual review failed for PR #{}",
                    pr_number
                );
            }
        }
    });

    (
        StatusCode::ACCEPTED,
        Json(json!({
            "status": "review_started",
            "repo": body.repo,
            "pr": pr_number,
        })),
    )
}

async fn review_status(State(state): State<AppState>) -> Json<Value> {
    let review_state = &state.review_state;

    let seen = review_state.seen_prs.lock().await;
    let completed = *review_state.reviews_completed.lock().await;
    let active = *review_state.active_reviews.lock().await;

    let repos: Vec<String> = review_state.repos.iter().map(|r| r.full_name()).collect();

    let seen_prs: serde_json::Map<String, Value> = seen
        .iter()
        .map(|(repo, prs)| {
            let mut numbers: Vec<u64> = prs.iter().copied().collect();
            numbers.sort();
            (repo.clone(), json!(numbers))
        })
        .collect();

    Json(json!({
        "repos": repos,
        "reviews_completed": completed,
        "active_reviews": active,
        "seen_prs": seen_prs,
    }))
}
