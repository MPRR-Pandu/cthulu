use serde::Deserialize;

/// Server configuration loaded from environment variables.
pub struct Config {
    pub port: u16,
    pub sentry_dsn: Option<String>,
    pub environment: String,
}

impl Config {
    pub fn from_env() -> Self {
        let port = std::env::var("PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(8081);

        let sentry_dsn = std::env::var("SENTRY_DSN").ok().filter(|s| !s.is_empty());

        let environment = std::env::var("ENVIRONMENT").unwrap_or_else(|_| "local".to_string());

        Config {
            port,
            sentry_dsn,
            environment,
        }
    }
}

// --- Source and Sink types used by flow runner ---

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SourceConfig {
    Rss {
        url: String,
        #[serde(default = "default_rss_limit")]
        limit: usize,
        #[serde(default)]
        keywords: Vec<String>,
    },
    WebScrape {
        url: String,
        #[serde(default)]
        keywords: Vec<String>,
    },
    GithubMergedPrs {
        repos: Vec<String>,
        #[serde(default = "default_since_days")]
        since_days: u64,
    },
    WebScraper {
        url: String,
        #[serde(default)]
        base_url: Option<String>,
        items_selector: String,
        #[serde(default)]
        title_selector: Option<String>,
        #[serde(default)]
        url_selector: Option<String>,
        #[serde(default)]
        summary_selector: Option<String>,
        #[serde(default)]
        date_selector: Option<String>,
        #[serde(default)]
        date_format: Option<String>,
        #[serde(default = "default_rss_limit")]
        limit: usize,
    },
}

fn default_rss_limit() -> usize {
    10
}

fn default_since_days() -> u64 {
    7
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SinkConfig {
    Slack {
        webhook_url_env: Option<String>,
        bot_token_env: Option<String>,
        channel: Option<String>,
    },
    Notion {
        token_env: String,
        database_id: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_invalid_port_uses_default() {
        unsafe { std::env::set_var("PORT", "not-a-number"); }
        let config = Config::from_env();
        assert_eq!(config.port, 8081);
        unsafe { std::env::remove_var("PORT"); }
    }

    #[test]
    fn test_config_empty_sentry_dsn_is_none() {
        unsafe { std::env::set_var("SENTRY_DSN", ""); }
        let config = Config::from_env();
        assert!(config.sentry_dsn.is_none());
        unsafe { std::env::remove_var("SENTRY_DSN"); }
    }
}
