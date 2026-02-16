pub mod slack;

use anyhow::{Context, Result};

use crate::config::SinkConfig;

pub async fn deliver(
    sink: &SinkConfig,
    text: &str,
    http_client: &reqwest::Client,
) -> Result<()> {
    match sink {
        SinkConfig::Slack {
            webhook_url_env,
            bot_token_env,
            channel,
        } => {
            if let Some(token_env) = bot_token_env {
                let bot_token = std::env::var(token_env)
                    .with_context(|| format!("env var {token_env} not set"))?;
                let channel = channel
                    .as_deref()
                    .context("slack bot_token_env requires a channel")?;
                slack::post_threaded_blocks(http_client, &bot_token, channel, text).await
            } else if let Some(webhook_env) = webhook_url_env {
                slack::post_message(http_client, webhook_env, text).await
            } else {
                anyhow::bail!("slack sink requires either webhook_url_env or bot_token_env");
            }
        }
    }
}
