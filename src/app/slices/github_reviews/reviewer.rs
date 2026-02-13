use anyhow::{Context, Result};
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

pub async fn review_pr(
    local_path: &Path,
    review_instructions: &str,
    pr_title: &str,
    pr_body: &str,
    pr_number: u64,
    base_ref: &str,
    head_ref: &str,
    diff: &str,
    repo_full_name: &str,
    head_sha: &str,
) -> Result<()> {
    // Git fetch to ensure we have latest refs
    let fetch_output = Command::new("git")
        .args(["fetch", "origin"])
        .current_dir(local_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .context("failed to run git fetch")?;

    if !fetch_output.status.success() {
        let stderr = String::from_utf8_lossy(&fetch_output.stderr);
        tracing::warn!(%stderr, "git fetch had non-zero exit (continuing anyway)");
    }

    let prompt = build_prompt(
        review_instructions,
        pr_title,
        pr_body,
        pr_number,
        base_ref,
        head_ref,
        local_path,
        diff,
        repo_full_name,
        head_sha,
    );

    let mut child = Command::new("claude")
        .args([
            "--print",
            "--verbose",
            "--dangerously-skip-permissions",
            "--output-format",
            "stream-json",
            "-", // read prompt from stdin
        ])
        .current_dir(local_path)
        .env_remove("CLAUDECODE")
        .env("CLAUDECODE", "")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("failed to spawn claude process")?;

    // Write the prompt to stdin and close it
    {
        use tokio::io::AsyncWriteExt;
        let mut stdin = child.stdin.take().expect("stdin piped");
        stdin.write_all(prompt.as_bytes()).await.context("failed to write prompt to stdin")?;
        // stdin drops here, closing the pipe
    }

    // Stream stderr lines into tracing as they arrive
    let stderr = child.stderr.take().expect("stderr piped");
    let stderr_handle = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.is_empty() {
                tracing::info!(source = "claude-stderr", "{}", line);
            }
        }
    });

    // Stream stdout — each line is a JSON event. Log them for visibility.
    let stdout = child.stdout.take().expect("stdout piped");
    let stdout_handle = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.is_empty() {
                continue;
            }
            if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("unknown");
                match event_type {
                    "system" => {
                        tracing::info!(source = "claude", "Session initialized");
                    }
                    "assistant" => {
                        if let Some(content) = event
                            .get("message")
                            .and_then(|m| m.get("content"))
                            .and_then(|c| c.as_array())
                        {
                            for block in content {
                                let block_type =
                                    block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                match block_type {
                                    "tool_use" => {
                                        let tool = block
                                            .get("name")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("?");
                                        let input = block
                                            .get("input")
                                            .map(|v| v.to_string())
                                            .unwrap_or_default();
                                        let input_short = if input.len() > 300 {
                                            format!("{}...", &input[..300])
                                        } else {
                                            input
                                        };
                                        tracing::info!(
                                            source = "claude",
                                            tool,
                                            "Tool: {} {}",
                                            tool,
                                            input_short
                                        );
                                    }
                                    "text" => {
                                        let text = block
                                            .get("text")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let text_short = if text.len() > 200 {
                                            format!("{}...", &text[..200])
                                        } else {
                                            text.to_string()
                                        };
                                        tracing::info!(
                                            source = "claude",
                                            "Text: {}",
                                            text_short
                                        );
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                    "result" => {
                        let cost = event
                            .get("total_cost_usd")
                            .and_then(|v| v.as_f64())
                            .unwrap_or(0.0);
                        let turns = event
                            .get("num_turns")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                        tracing::info!(
                            source = "claude",
                            cost_usd = cost,
                            turns,
                            "Claude finished — {} turns, ${:.4}",
                            turns,
                            cost
                        );
                    }
                    _ => {}
                }
            }
        }
    });

    let status = child.wait().await.context("failed to wait on claude")?;
    let _ = stderr_handle.await;
    let _ = stdout_handle.await;

    if !status.success() {
        anyhow::bail!("claude exited with {}", status);
    }

    Ok(())
}

fn build_prompt(
    review_instructions: &str,
    pr_title: &str,
    pr_body: &str,
    pr_number: u64,
    base_ref: &str,
    head_ref: &str,
    local_path: &Path,
    diff: &str,
    repo_full_name: &str,
    head_sha: &str,
) -> String {
    format!(
        r#"{review_instructions}

---

## PR Details

- **Repo**: {repo_full_name}
- **PR #{pr_number}**: {pr_title}
- **Description**: {pr_body}
- **Base branch**: {base_ref}
- **Head branch**: {head_ref}
- **Head SHA**: {head_sha}

You are in the repo at `{local_path}`. Navigate the codebase to understand context around the changed files. Look at related files, imports, tests, and call sites.

When posting your review, use these exact values:
- Repo: `{repo_full_name}`
- PR number: `{pr_number}`
- Head SHA: `{head_sha}`

## Diff

```diff
{diff}
```

Review the code, then post your review to GitHub using `gh` as described in the instructions above."#,
        local_path = local_path.display(),
    )
}
