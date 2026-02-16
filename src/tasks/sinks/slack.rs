use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::json;

// ---------------------------------------------------------------------------
// Block Kit types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Header {
        text: TextObject,
    },
    Section {
        text: TextObject,
    },
    Divider,
}

#[derive(Debug, Clone, Serialize)]
pub struct TextObject {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub text: String,
}

const MAX_HEADER_LEN: usize = 150;
const MAX_SECTION_LEN: usize = 3000;
const MAX_BLOCKS_PER_MESSAGE: usize = 50;

// ---------------------------------------------------------------------------
// Webhook (legacy) path — unchanged
// ---------------------------------------------------------------------------

pub async fn post_message(
    client: &reqwest::Client,
    webhook_url_env: &str,
    text: &str,
) -> Result<()> {
    let webhook_url = std::env::var(webhook_url_env)
        .with_context(|| format!("environment variable {webhook_url_env} not set"))?;

    post_to_url(client, &webhook_url, text).await
}

pub async fn post_to_url(
    client: &reqwest::Client,
    webhook_url: &str,
    text: &str,
) -> Result<()> {
    let slack_text = markdown_to_slack(text);

    let response = client
        .post(webhook_url)
        .json(&json!({ "text": slack_text }))
        .send()
        .await
        .context("failed to post to Slack webhook")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Slack webhook returned {status}: {body}");
    }

    tracing::info!("Delivered message to Slack");
    Ok(())
}

// ---------------------------------------------------------------------------
// Web API (Block Kit + threading) path
// ---------------------------------------------------------------------------

/// Post a message with Block Kit formatting and optional threading.
///
/// If `full_text` contains a `---THREAD---` delimiter, the part above becomes
/// the main channel message and the part below is posted as a thread reply.
pub async fn post_threaded_blocks(
    client: &reqwest::Client,
    bot_token: &str,
    channel: &str,
    full_text: &str,
) -> Result<()> {
    let parts: Vec<&str> = full_text.splitn(2, "---THREAD---").collect();

    let main_text = parts[0].trim();
    let thread_text = parts.get(1).map(|s| s.trim());

    let main_blocks = markdown_to_blocks(main_text);
    let ts = post_blocks(client, bot_token, channel, &main_blocks, None)
        .await
        .context("failed to post main message")?;

    if let Some(detail) = thread_text {
        if !detail.is_empty() {
            let thread_blocks = markdown_to_blocks(detail);
            post_blocks(client, bot_token, channel, &thread_blocks, Some(&ts))
                .await
                .context("failed to post thread reply")?;
        }
    }

    tracing::info!("Delivered Block Kit message to Slack");
    Ok(())
}

/// Post blocks to Slack via `chat.postMessage`. Returns the message `ts`.
async fn post_blocks(
    client: &reqwest::Client,
    bot_token: &str,
    channel: &str,
    blocks: &[Block],
    thread_ts: Option<&str>,
) -> Result<String> {
    let blocks = if blocks.len() > MAX_BLOCKS_PER_MESSAGE {
        let mut truncated = blocks[..MAX_BLOCKS_PER_MESSAGE - 1].to_vec();
        truncated.push(Block::Section {
            text: TextObject {
                kind: "mrkdwn",
                text: "_Message truncated — too many blocks._".to_string(),
            },
        });
        truncated
    } else {
        blocks.to_vec()
    };

    // Build a fallback plain-text summary from section blocks
    let fallback: String = blocks
        .iter()
        .filter_map(|b| match b {
            Block::Section { text } => Some(text.text.as_str()),
            Block::Header { text } => Some(text.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");

    let mut body = json!({
        "channel": channel,
        "blocks": blocks,
        "text": fallback,
    });

    if let Some(ts) = thread_ts {
        body["thread_ts"] = json!(ts);
    }

    let response = client
        .post("https://slack.com/api/chat.postMessage")
        .header("Authorization", format!("Bearer {bot_token}"))
        .json(&body)
        .send()
        .await
        .context("failed to call chat.postMessage")?;

    let status = response.status();
    let resp_body: serde_json::Value = response
        .json()
        .await
        .context("failed to parse Slack API response")?;

    if !status.is_success() || resp_body["ok"].as_bool() != Some(true) {
        let err = resp_body["error"].as_str().unwrap_or("unknown error");
        anyhow::bail!("chat.postMessage failed ({status}): {err}");
    }

    resp_body["ts"]
        .as_str()
        .map(|s| s.to_string())
        .context("Slack response missing ts field")
}

// ---------------------------------------------------------------------------
// Markdown → Block Kit blocks
// ---------------------------------------------------------------------------

/// Convert markdown text into Slack Block Kit blocks.
pub fn markdown_to_blocks(text: &str) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    let mut current_lines: Vec<String> = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();

        // Horizontal rule → flush + Divider
        if trimmed == "---" || trimmed == "***" || trimmed == "___" {
            flush_section(&mut blocks, &mut current_lines);
            blocks.push(Block::Divider);
            continue;
        }

        // Headers → flush + Header block
        if let Some(header_text) = trimmed
            .strip_prefix("### ")
            .or_else(|| trimmed.strip_prefix("## "))
            .or_else(|| trimmed.strip_prefix("# "))
        {
            flush_section(&mut blocks, &mut current_lines);
            let mut h = header_text.trim().to_string();
            if h.len() > MAX_HEADER_LEN {
                let mut end = MAX_HEADER_LEN;
                while !h.is_char_boundary(end) {
                    end -= 1;
                }
                h.truncate(end);
            }
            blocks.push(Block::Header {
                text: TextObject {
                    kind: "plain_text",
                    text: h,
                },
            });
            continue;
        }

        // Everything else: accumulate as mrkdwn content
        let converted = if let Some(rest) = trimmed.strip_prefix("- ") {
            format!("• {rest}")
        } else if let Some(rest) = trimmed.strip_prefix("* ") {
            format!("• {rest}")
        } else {
            line.to_string()
        };

        current_lines.push(converted);
    }

    flush_section(&mut blocks, &mut current_lines);
    blocks
}

/// Flush accumulated lines into one or more Section blocks (chunked at 3000 chars).
fn flush_section(blocks: &mut Vec<Block>, lines: &mut Vec<String>) {
    if lines.is_empty() {
        return;
    }

    let joined = lines.join("\n");
    lines.clear();

    let formatted = convert_bold(&convert_links(&joined));

    // Chunk at line boundaries to stay under MAX_SECTION_LEN
    let mut chunk = String::new();
    for line in formatted.lines() {
        // +1 for the newline we'd add
        if !chunk.is_empty() && chunk.len() + 1 + line.len() > MAX_SECTION_LEN {
            push_section_block(blocks, &chunk);
            chunk.clear();
        }
        if !chunk.is_empty() {
            chunk.push('\n');
        }
        chunk.push_str(line);
    }

    if !chunk.is_empty() {
        push_section_block(blocks, &chunk);
    }
}

fn push_section_block(blocks: &mut Vec<Block>, text: &str) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    blocks.push(Block::Section {
        text: TextObject {
            kind: "mrkdwn",
            text: trimmed.to_string(),
        },
    });
}

// ---------------------------------------------------------------------------
// Markdown → Slack mrkdwn (plain text for webhooks)
// ---------------------------------------------------------------------------

/// Convert markdown to Slack mrkdwn format.
fn markdown_to_slack(input: &str) -> String {
    let mut lines: Vec<String> = Vec::new();

    for line in input.lines() {
        let trimmed = line.trim();

        // Headers → *bold text*
        if let Some(rest) = trimmed.strip_prefix("### ") {
            lines.push(format!("*{}*", rest.trim()));
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("## ") {
            lines.push(format!("*{}*", rest.trim()));
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("# ") {
            lines.push(format!("*{}*", rest.trim()));
            continue;
        }

        // Bullet markers: - or * at start → •
        let converted = if let Some(rest) = trimmed.strip_prefix("- ") {
            format!("• {rest}")
        } else if let Some(rest) = trimmed.strip_prefix("* ") {
            format!("• {rest}")
        } else {
            line.to_string()
        };

        lines.push(converted);
    }

    let mut result = lines.join("\n");

    // Inline links: [text](url) → <url|text>
    result = convert_links(&result);

    // Bold: **text** → *text*
    result = convert_bold(&result);

    result
}

/// Convert markdown links [text](url) to Slack format <url|text>.
fn convert_links(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        if chars[i] == '[' {
            // Try to parse [text](url)
            if let Some((text, url, end)) = parse_md_link(&chars, i) {
                out.push('<');
                out.push_str(&url);
                out.push('|');
                out.push_str(&text);
                out.push('>');
                i = end;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }

    out
}

/// Try to parse a markdown link starting at position `start` (which should be '[').
/// Returns (text, url, end_position) if successful.
fn parse_md_link(chars: &[char], start: usize) -> Option<(String, String, usize)> {
    // Find closing ]
    let mut i = start + 1;
    let mut text = String::new();
    while i < chars.len() && chars[i] != ']' {
        text.push(chars[i]);
        i += 1;
    }
    if i >= chars.len() {
        return None;
    }
    // chars[i] == ']', next must be '('
    i += 1;
    if i >= chars.len() || chars[i] != '(' {
        return None;
    }
    i += 1;
    let mut url = String::new();
    while i < chars.len() && chars[i] != ')' {
        url.push(chars[i]);
        i += 1;
    }
    if i >= chars.len() {
        return None;
    }
    // chars[i] == ')'
    Some((text, url, i + 1))
}

/// Convert markdown bold **text** to Slack bold *text*.
fn convert_bold(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        if i + 1 < chars.len() && chars[i] == '*' && chars[i + 1] == '*' {
            // Find the closing **
            if let Some(end) = find_closing_double_star(&chars, i + 2) {
                out.push('*');
                for &c in &chars[i + 2..end] {
                    out.push(c);
                }
                out.push('*');
                i = end + 2;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }

    out
}

fn find_closing_double_star(chars: &[char], start: usize) -> Option<usize> {
    let mut i = start;
    while i + 1 < chars.len() {
        if chars[i] == '*' && chars[i + 1] == '*' {
            return Some(i);
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_headers_to_bold() {
        assert_eq!(markdown_to_slack("# Big Header"), "*Big Header*");
        assert_eq!(markdown_to_slack("## Section"), "*Section*");
        assert_eq!(markdown_to_slack("### Sub"), "*Sub*");
    }

    #[test]
    fn test_bullets() {
        assert_eq!(markdown_to_slack("- item one"), "• item one");
        assert_eq!(markdown_to_slack("* item two"), "• item two");
    }

    #[test]
    fn test_bold() {
        assert_eq!(markdown_to_slack("this is **bold** text"), "this is *bold* text");
    }

    #[test]
    fn test_links() {
        assert_eq!(
            markdown_to_slack("check [this](https://example.com) out"),
            "check <https://example.com|this> out"
        );
    }

    #[test]
    fn test_combined() {
        let md = "# Daily Brief\n\n- **BTC** up 5%\n- Check [CoinDesk](https://coindesk.com)\n\nThis is a paragraph.";
        let expected = "*Daily Brief*\n\n• *BTC* up 5%\n• Check <https://coindesk.com|CoinDesk>\n\nThis is a paragraph.";
        assert_eq!(markdown_to_slack(md), expected);
    }

    #[test]
    fn test_passthrough() {
        assert_eq!(markdown_to_slack("plain text"), "plain text");
    }

    // Block Kit tests

    #[test]
    fn test_markdown_to_blocks_header() {
        let blocks = markdown_to_blocks("# My Header\nSome text");
        assert_eq!(blocks.len(), 2);
        match &blocks[0] {
            Block::Header { text } => {
                assert_eq!(text.kind, "plain_text");
                assert_eq!(text.text, "My Header");
            }
            _ => panic!("expected Header block"),
        }
        match &blocks[1] {
            Block::Section { text } => {
                assert_eq!(text.kind, "mrkdwn");
                assert!(text.text.contains("Some text"));
            }
            _ => panic!("expected Section block"),
        }
    }

    #[test]
    fn test_markdown_to_blocks_divider() {
        let blocks = markdown_to_blocks("Above\n---\nBelow");
        assert!(blocks.len() >= 3);
        assert!(matches!(blocks[1], Block::Divider));
    }

    #[test]
    fn test_markdown_to_blocks_bullets_converted() {
        let blocks = markdown_to_blocks("- item one\n- item two");
        match &blocks[0] {
            Block::Section { text } => {
                assert!(text.text.contains('•'));
            }
            _ => panic!("expected Section"),
        }
    }

    #[test]
    fn test_markdown_to_blocks_links_and_bold() {
        let blocks = markdown_to_blocks("Check **this** [link](https://example.com)");
        match &blocks[0] {
            Block::Section { text } => {
                assert!(text.text.contains("*this*"));
                assert!(text.text.contains("<https://example.com|link>"));
            }
            _ => panic!("expected Section"),
        }
    }

    #[test]
    fn test_markdown_to_blocks_long_header_truncated() {
        let long_header = format!("# {}", "A".repeat(200));
        let blocks = markdown_to_blocks(&long_header);
        match &blocks[0] {
            Block::Header { text } => {
                assert!(text.text.len() <= MAX_HEADER_LEN);
            }
            _ => panic!("expected Header"),
        }
    }

    #[test]
    fn test_block_kit_serialization() {
        let block = Block::Header {
            text: TextObject {
                kind: "plain_text",
                text: "Hello".to_string(),
            },
        };
        let json = serde_json::to_value(&block).unwrap();
        assert_eq!(json["type"], "header");
        assert_eq!(json["text"]["type"], "plain_text");
        assert_eq!(json["text"]["text"], "Hello");
    }
}
