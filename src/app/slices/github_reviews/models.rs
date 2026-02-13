use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct RepoConfig {
    pub owner: String,
    pub repo: String,
    pub local_path: PathBuf,
}

impl RepoConfig {
    /// Parse `GITHUB_REPOS` env var format: `owner/repo:/absolute/path,owner/repo2:/other/path`
    pub fn parse_env(value: &str) -> Vec<RepoConfig> {
        value
            .split(',')
            .filter_map(|entry| {
                let entry = entry.trim();
                if entry.is_empty() {
                    return None;
                }
                // Split on first colon that's followed by a slash (to handle "owner/repo:/path")
                let colon_pos = entry.find(":/")?;
                let slug = &entry[..colon_pos];
                let path = &entry[colon_pos + 1..];
                let (owner, repo) = slug.split_once('/')?;
                Some(RepoConfig {
                    owner: owner.to_string(),
                    repo: repo.to_string(),
                    local_path: PathBuf::from(path),
                })
            })
            .collect()
    }

    pub fn full_name(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    pub head: PrRef,
    pub base: PrRef,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PrRef {
    pub sha: String,
    #[serde(rename = "ref")]
    pub ref_name: String,
}

