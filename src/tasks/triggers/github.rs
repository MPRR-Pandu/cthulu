use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::Result;

use crate::config::GithubTriggerConfig;
use crate::github::{client as gh_client, models::RepoConfig};
use crate::tasks::context::render_prompt;
use crate::tasks::executors::Executor;
use crate::tasks::TaskState;

pub struct GithubPrTrigger {
    http_client: Arc<reqwest::Client>,
    token: String,
    config: GithubTriggerConfig,
    task_state: Arc<TaskState>,
}

impl GithubPrTrigger {
    pub fn new(
        http_client: Arc<reqwest::Client>,
        token: String,
        config: GithubTriggerConfig,
        task_state: Arc<TaskState>,
    ) -> Self {
        Self {
            http_client,
            token,
            config,
            task_state,
        }
    }

    fn repo_configs(&self) -> Vec<RepoConfig> {
        self.config
            .repos
            .iter()
            .filter_map(|entry| {
                let (owner, repo) = entry.owner_repo()?;
                Some(RepoConfig {
                    owner: owner.to_string(),
                    repo: repo.to_string(),
                    local_path: entry.path.clone(),
                })
            })
            .collect()
    }

    pub async fn seed(&self) -> Result<()> {
        let repos = self.repo_configs();
        for repo in &repos {
            let max_retries = 10;
            let mut attempt = 0u32;
            loop {
                attempt += 1;
                match gh_client::fetch_open_prs(
                    &self.http_client,
                    &self.token,
                    &repo.owner,
                    &repo.repo,
                )
                .await
                {
                    Ok(prs) => {
                        let mut seen = self.task_state.seen_prs.lock().await;
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
                                "Failed to seed PRs after {} attempts",
                                max_retries
                            );
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
        Ok(())
    }

    pub async fn poll_loop(
        &self,
        task_name: &str,
        prompt_template: &str,
        executor: &dyn Executor,
        http_client: &Arc<reqwest::Client>,
        token: &str,
        task_state: &Arc<TaskState>,
    ) {
        let repos = self.repo_configs();
        let seeded_repos: Vec<RepoConfig> = {
            let seen = task_state.seen_prs.lock().await;
            repos
                .into_iter()
                .filter(|r| seen.contains_key(&r.full_name()))
                .collect()
        };

        tracing::info!(
            task = %task_name,
            repos = seeded_repos.len(),
            interval = self.config.poll_interval,
            "Polling {} repos every {}s",
            seeded_repos.len(),
            self.config.poll_interval
        );

        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(self.config.poll_interval));

        loop {
            interval.tick().await;

            for repo in &seeded_repos {
                let prs = match gh_client::fetch_open_prs(
                    http_client, token, &repo.owner, &repo.repo,
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
                    let mut seen = task_state.seen_prs.lock().await;
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
                        task = %task_name,
                        repo = %repo.full_name(),
                        pr = pr.number,
                        title = %pr.title,
                        "New PR #{} detected: {}",
                        pr.number,
                        pr.title
                    );

                    // Post "starting review" comment
                    let start_msg = format!(
                        ":robot: **Cthulu Review Bot** is starting a deep-dive review of this PR...\n\n\
                         _Reviewing PR #{} — this may take a few minutes._",
                        pr.number
                    );
                    if let Err(e) = gh_client::post_comment(
                        http_client, token, &repo.owner, &repo.repo, pr.number, &start_msg,
                    )
                    .await
                    {
                        tracing::warn!(error = %e, "Failed to post starting comment");
                    }

                    // Fetch diff
                    let diff = match gh_client::fetch_pr_diff(
                        http_client, token, &repo.owner, &repo.repo, pr.number,
                    )
                    .await
                    {
                        Ok(d) => d,
                        Err(e) => {
                            tracing::error!(error = %e, "Failed to fetch PR diff");
                            continue;
                        }
                    };

                    // Build context
                    let mut context = HashMap::new();
                    context.insert("diff".to_string(), diff);
                    context.insert("pr_number".to_string(), pr.number.to_string());
                    context.insert("pr_title".to_string(), pr.title.clone());
                    context.insert(
                        "pr_body".to_string(),
                        pr.body.clone().unwrap_or_default(),
                    );
                    context.insert("base_ref".to_string(), pr.base.ref_name.clone());
                    context.insert("head_ref".to_string(), pr.head.ref_name.clone());
                    context.insert("head_sha".to_string(), pr.head.sha.clone());
                    context.insert("repo".to_string(), repo.full_name());
                    context.insert(
                        "local_path".to_string(),
                        repo.local_path.display().to_string(),
                    );

                    let rendered_prompt = render_prompt(prompt_template, &context);

                    // Git fetch before review
                    let _ = tokio::process::Command::new("git")
                        .args(["fetch", "origin"])
                        .current_dir(&repo.local_path)
                        .output()
                        .await;

                    // Execute
                    {
                        let mut active = task_state.active_reviews.lock().await;
                        *active += 1;
                    }

                    let result = executor
                        .execute(&rendered_prompt, &repo.local_path)
                        .await;

                    {
                        let mut active = task_state.active_reviews.lock().await;
                        *active -= 1;
                    }

                    match result {
                        Ok(()) => {
                            let mut completed = task_state.reviews_completed.lock().await;
                            *completed += 1;
                            tracing::info!(
                                task = %task_name,
                                repo = %repo.full_name(),
                                pr = pr.number,
                                "Review completed for PR #{}",
                                pr.number
                            );
                        }
                        Err(e) => {
                            tracing::error!(
                                task = %task_name,
                                repo = %repo.full_name(),
                                pr = pr.number,
                                error = %e,
                                "Review failed for PR #{}",
                                pr.number
                            );
                        }
                    }
                }
            }
        }
    }
}
