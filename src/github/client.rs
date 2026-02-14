use anyhow::{Context, Result};
use reqwest::Client;

use super::models::PullRequest;

const USER_AGENT: &str = "cthulu-bot";
const GITHUB_API: &str = "https://api.github.com";

pub async fn fetch_open_prs(
    client: &Client,
    token: &str,
    owner: &str,
    repo: &str,
) -> Result<Vec<PullRequest>> {
    let url = format!("{GITHUB_API}/repos/{owner}/{repo}/pulls");
    let resp = client
        .get(&url)
        .query(&[
            ("state", "open"),
            ("sort", "created"),
            ("direction", "desc"),
        ])
        .bearer_auth(token)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .context("failed to fetch open PRs")?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("GitHub API error {status} fetching PRs for {owner}/{repo}: {body}");
    }

    let prs: Vec<PullRequest> = resp.json().await.context("failed to parse PR list")?;
    Ok(prs)
}

pub async fn fetch_single_pr(
    client: &Client,
    token: &str,
    owner: &str,
    repo: &str,
    pr_number: u64,
) -> Result<PullRequest> {
    let url = format!("{GITHUB_API}/repos/{owner}/{repo}/pulls/{pr_number}");
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .context("failed to fetch PR")?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("GitHub API error {status} fetching PR #{pr_number}: {body}");
    }

    resp.json().await.context("failed to parse PR")
}

pub async fn fetch_pr_diff(
    client: &Client,
    token: &str,
    owner: &str,
    repo: &str,
    pr_number: u64,
) -> Result<String> {
    let url = format!("{GITHUB_API}/repos/{owner}/{repo}/pulls/{pr_number}");
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github.v3.diff")
        .send()
        .await
        .context("failed to fetch PR diff")?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("GitHub API error {status} fetching diff for PR #{pr_number}: {body}");
    }

    resp.text().await.context("failed to read diff body")
}

pub async fn post_comment(
    client: &Client,
    token: &str,
    owner: &str,
    repo: &str,
    pr_number: u64,
    body: &str,
) -> Result<()> {
    let url = format!("{GITHUB_API}/repos/{owner}/{repo}/issues/{pr_number}/comments");
    let payload = serde_json::json!({ "body": body });

    let resp = client
        .post(&url)
        .bearer_auth(token)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .json(&payload)
        .send()
        .await
        .context("failed to post comment")?;

    let status = resp.status();
    if !status.is_success() {
        let resp_body = resp.text().await.unwrap_or_default();
        anyhow::bail!("GitHub API error {status} posting comment on PR #{pr_number}: {resp_body}");
    }

    Ok(())
}
