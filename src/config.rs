use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
pub struct Config {
    pub server: ServerConfig,
    pub github: Option<GithubConfig>,
    #[serde(default)]
    pub tasks: Vec<TaskConfig>,
}

#[derive(Debug, Deserialize)]
pub struct ServerConfig {
    #[serde(default = "default_port")]
    pub port: u16,
    pub sentry_dsn_env: Option<String>,
    #[serde(default = "default_environment")]
    pub environment: String,
}

fn default_port() -> u16 {
    8081
}

fn default_environment() -> String {
    "local".to_string()
}

#[derive(Debug, Deserialize)]
pub struct GithubConfig {
    pub token_env: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TaskConfig {
    pub name: String,
    pub executor: ExecutorType,
    pub prompt: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    pub trigger: TriggerConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutorType {
    ClaudeCode,
    ClaudeApi,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TriggerConfig {
    pub github: Option<GithubTriggerConfig>,
    pub cron: Option<CronTriggerConfig>,
    pub webhook: Option<WebhookTriggerConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GithubTriggerConfig {
    pub event: String,
    pub repos: Vec<RepoEntry>,
    #[serde(default = "default_poll_interval")]
    pub poll_interval: u64,
}

fn default_poll_interval() -> u64 {
    60
}

#[derive(Debug, Clone, Deserialize)]
pub struct RepoEntry {
    pub slug: String,
    pub path: PathBuf,
}

impl RepoEntry {
    pub fn owner_repo(&self) -> Option<(&str, &str)> {
        self.slug.split_once('/')
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct CronTriggerConfig {
    pub schedule: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WebhookTriggerConfig {
    pub path: String,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("failed to read config file: {}", path.display()))?;
        let config: Config =
            toml::from_str(&content).with_context(|| "failed to parse cthulu.toml")?;
        Ok(config)
    }

    pub fn github_token(&self) -> Option<String> {
        self.github
            .as_ref()
            .and_then(|g| std::env::var(&g.token_env).ok())
            .filter(|t| !t.is_empty())
    }

    pub fn sentry_dsn(&self) -> String {
        self.server
            .sentry_dsn_env
            .as_ref()
            .and_then(|env_key| std::env::var(env_key).ok())
            .unwrap_or_default()
    }
}
