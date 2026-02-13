pub mod github_client;
pub mod models;
pub mod reviewer;
pub mod routes;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex;

use models::RepoConfig;

#[derive(Debug)]
pub struct ReviewState {
    pub seen_prs: Mutex<HashMap<String, HashSet<u64>>>,
    pub reviews_completed: Mutex<u64>,
    pub active_reviews: Mutex<u64>,
    pub repos: Vec<RepoConfig>,
    pub github_token: Mutex<String>,
    pub review_instructions: Mutex<String>,
}

impl ReviewState {
    pub fn new(repos: Vec<RepoConfig>) -> Self {
        Self {
            seen_prs: Mutex::new(HashMap::new()),
            reviews_completed: Mutex::new(0),
            active_reviews: Mutex::new(0),
            repos,
            github_token: Mutex::new(String::new()),
            review_instructions: Mutex::new(String::new()),
        }
    }
}

pub fn start_poller(
    http_client: Arc<reqwest::Client>,
    token: String,
    repos: Vec<RepoConfig>,
    interval_secs: u64,
    review_instructions: String,
    review_state: Arc<ReviewState>,
) {
    let token_clone = token.clone();
    let instructions_clone = review_instructions.clone();
    tokio::spawn(async move {
        // Store token and instructions in ReviewState so routes can use them
        {
            *review_state.github_token.lock().await = token_clone;
            *review_state.review_instructions.lock().await = instructions_clone;
        }
        poller_loop(
            http_client,
            token,
            repos,
            interval_secs,
            review_instructions,
            review_state,
        )
        .await;
    });
}

async fn poller_loop(
    http_client: Arc<reqwest::Client>,
    token: String,
    repos: Vec<RepoConfig>,
    interval_secs: u64,
    review_instructions: String,
    review_state: Arc<ReviewState>,
) {
    tracing::info!(
        repo_count = repos.len(),
        interval_secs,
        "Starting PR poller for {} repos, interval: {}s",
        repos.len(),
        interval_secs
    );

    // Seed phase: record all currently open PRs so we don't review them
    // Retries indefinitely — we must seed before polling to avoid reviewing every open PR
    for repo in &repos {
        let max_retries = 10;
        let mut attempt = 0;
        loop {
            attempt += 1;
            match github_client::fetch_open_prs(
                &http_client,
                &token,
                &repo.owner,
                &repo.repo,
            )
            .await
            {
                Ok(prs) => {
                    let mut seen = review_state.seen_prs.lock().await;
                    let pr_numbers: HashSet<u64> = prs.iter().map(|pr| pr.number).collect();
                    tracing::info!(
                        repo = %repo.full_name(),
                        count = pr_numbers.len(),
                        "Seeded {} existing PRs for {}",
                        pr_numbers.len(),
                        repo.full_name()
                    );
                    seen.insert(repo.full_name(), pr_numbers);
                    break;
                }
                Err(e) => {
                    if attempt >= max_retries {
                        tracing::error!(
                            repo = %repo.full_name(),
                            error = %e,
                            "Failed to seed PRs after {} attempts — skipping repo",
                            max_retries
                        );
                        // Don't add to seen map at all — repo won't be polled
                        break;
                    }
                    let backoff = std::time::Duration::from_secs(2u64.pow(attempt.min(5)));
                    tracing::warn!(
                        repo = %repo.full_name(),
                        error = %e,
                        attempt,
                        "Failed to seed PRs, retrying in {:?}...",
                        backoff
                    );
                    tokio::time::sleep(backoff).await;
                }
            }
        }
    }

    // Only poll repos that were successfully seeded
    let seeded_repos: Vec<RepoConfig> = {
        let seen = review_state.seen_prs.lock().await;
        repos
            .into_iter()
            .filter(|r| seen.contains_key(&r.full_name()))
            .collect()
    };

    tracing::info!(
        "Polling {} of {} configured repos (seeded successfully)",
        seeded_repos.len(),
        review_state.repos.len()
    );

    let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_secs));

    loop {
        interval.tick().await;

        for repo in &seeded_repos {
            let prs = match github_client::fetch_open_prs(
                &http_client,
                &token,
                &repo.owner,
                &repo.repo,
            )
            .await
            {
                Ok(prs) => prs,
                Err(e) => {
                    tracing::error!(repo = %repo.full_name(), error = %e, "Failed to fetch PRs");
                    continue;
                }
            };

            let new_prs = {
                let mut seen = review_state.seen_prs.lock().await;
                let seen_set = seen.entry(repo.full_name()).or_default();
                let mut new = Vec::new();
                for pr in prs {
                    if !seen_set.contains(&pr.number) {
                        seen_set.insert(pr.number);
                        new.push(pr);
                    }
                }
                new
            };

            for pr in new_prs {
                tracing::info!(
                    repo = %repo.full_name(),
                    pr = pr.number,
                    title = %pr.title,
                    "New PR #{} detected: {}",
                    pr.number,
                    pr.title
                );

                let client = http_client.clone();
                let token = token.clone();
                let repo = repo.clone();
                let instructions = review_instructions.clone();
                let state = review_state.clone();

                tokio::spawn(async move {
                    {
                        let mut active = state.active_reviews.lock().await;
                        *active += 1;
                    }

                    let result = handle_review(&client, &token, &repo, &pr, &instructions).await;

                    {
                        let mut active = state.active_reviews.lock().await;
                        *active -= 1;
                    }

                    match result {
                        Ok(()) => {
                            let mut completed = state.reviews_completed.lock().await;
                            *completed += 1;
                            tracing::info!(
                                repo = %repo.full_name(),
                                pr = pr.number,
                                "Review posted for PR #{}",
                                pr.number
                            );
                        }
                        Err(e) => {
                            tracing::error!(
                                repo = %repo.full_name(),
                                pr = pr.number,
                                error = %e,
                                "Failed to review PR #{}",
                                pr.number
                            );
                        }
                    }
                });
            }
        }
    }
}

pub async fn handle_review(
    client: &reqwest::Client,
    token: &str,
    repo: &RepoConfig,
    pr: &models::PullRequest,
    review_instructions: &str,
) -> anyhow::Result<()> {
    tracing::info!(
        repo = %repo.full_name(),
        pr = pr.number,
        "Spawning Claude review for PR #{}",
        pr.number
    );

    // Post "starting review" comment immediately
    let start_msg = format!(
        ":robot: **Cthulu Review Bot** is starting a deep-dive review of this PR...\n\n\
         _Reviewing PR #{} — this may take a few minutes._",
        pr.number
    );
    if let Err(e) =
        github_client::post_comment(client, token, &repo.owner, &repo.repo, pr.number, &start_msg)
            .await
    {
        tracing::warn!(error = %e, "Failed to post starting comment (continuing with review)");
    }

    // Fetch the diff from GitHub
    let diff =
        github_client::fetch_pr_diff(client, token, &repo.owner, &repo.repo, pr.number).await?;

    let pr_body = pr.body.as_deref().unwrap_or("");

    // Run Claude reviewer — Claude posts its review directly via `gh` CLI
    reviewer::review_pr(
        &repo.local_path,
        review_instructions,
        &pr.title,
        pr_body,
        pr.number,
        &pr.base.ref_name,
        &pr.head.ref_name,
        &diff,
        &repo.full_name(),
        &pr.head.sha,
    )
    .await?;

    Ok(())
}
