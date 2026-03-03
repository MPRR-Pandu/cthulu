# cthulu-mcp

MCP (Model Context Protocol) server for **Cthulu** — an AI workflow automation platform that runs Claude Code agents in visual DAG pipelines.

Exposes **30 tools** over stdio (JSON-RPC 2.0 / MCP protocol) so that Claude Desktop, Claude Code, or any MCP-compatible client can create, manage, and run Cthulu workflows conversationally.

## Tools

| Category | Tools | Description |
|----------|-------|-------------|
| **Flows** (10) | `list_flows`, `get_flow`, `describe_flow`, `create_flow`, `update_flow`, `delete_flow`, `trigger_flow`, `get_flow_runs`, `get_flow_schedule`, `list_workflow_files` | Full CRUD + run management for workflow DAGs |
| **Agents** (10) | `list_agents`, `get_agent`, `create_agent`, `update_agent`, `delete_agent`, `list_agent_sessions`, `create_agent_session`, `delete_agent_session`, `get_session_log`, `chat_with_agent` | Agent CRUD + interactive chat with polling |
| **Prompts** (5) | `list_prompts`, `get_prompt`, `create_prompt`, `update_prompt`, `delete_prompt` | Prompt template library management |
| **Utility** (5) | `get_node_types`, `list_templates`, `import_template`, `validate_cron`, `get_scheduler_status`, `get_token_status` | Node schema, templates, cron validation, scheduler overview |
| **Search** (2) | `web_search`, `fetch_content` | DuckDuckGo via SearXNG (or DDG fallback) + page fetch |

## Prerequisites

- **Cthulu backend** running on `http://localhost:8081` (the Rust binary `cthulu serve`)
- **SearXNG** (optional) on `http://localhost:8888` for unlimited web search — falls back to DuckDuckGo HTML scraping if unavailable

## Build

From the project root:

```bash
cargo build --release --bin cthulu-mcp
```

The binary is output to `target/release/cthulu-mcp`.

## Usage

### Direct (stdio)

```bash
./target/release/cthulu-mcp \
  --base-url http://localhost:8081 \
  --searxng-url http://localhost:8888
```

To disable SearXNG and always use the DuckDuckGo fallback:

```bash
./target/release/cthulu-mcp --searxng-url disabled
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cthulu": {
      "command": "/absolute/path/to/target/release/cthulu-mcp",
      "args": [
        "--base-url", "http://localhost:8081",
        "--searxng-url", "http://localhost:8888"
      ]
    }
  }
}
```

### With the launcher script (recommended)

The launcher script auto-starts the backend if it's not already running:

```json
{
  "mcpServers": {
    "cthulu": {
      "command": "/absolute/path/to/scripts/mcp-launcher.sh",
      "args": [
        "--base-url", "http://localhost:8081",
        "--searxng-url", "http://localhost:8888"
      ]
    }
  }
}
```

The launcher will:
1. Check if the backend is running on `:8081`
2. If not, build + start it in the background (logs to `logs/backend.log`)
3. Wait up to 10 seconds for it to become healthy
4. Exec into `cthulu-mcp` with your args

## Pipeline Model

Cthulu workflows are directed acyclic graphs (DAGs) with this shape:

```
trigger -> source(s) -> [filter(s)] -> executor -> sink(s)
```

| Stage | Node Types | Description |
|-------|-----------|-------------|
| **Trigger** | `cron`, `github-pr`, `webhook`, `manual` | What starts the flow |
| **Source** | `rss`, `web-scrape`, `web-scraper`, `github-merged-prs`, `market-data`, `google-sheets` | Where data comes from |
| **Filter** | `keyword` | Optional — narrows items before processing |
| **Executor** | `claude-code`, `vm-sandbox` | AI processing step |
| **Sink** | `slack`, `notion` | Where results are delivered |

Multiple sources run in parallel and their results merge. Multiple sinks all receive the same executor output.

## Interactive Workflow Creation

Once registered in Claude Desktop, you can create workflows with plain English. Claude will guide you through an interactive flow:

1. **Ask** — Claude asks for the workflow name and details
2. **Preview** — Claude shows a draft of the pipeline (trigger → source → executor → sink)
3. **Confirm or Reject** — You decide whether to proceed or cancel
4. **Build** — If confirmed, Claude creates the flow and asks if you want to trigger a test run

This means you can say "reject" at step 3 and nothing gets created, or say "proceed" and then choose to "execute" or "skip" the test run.

### Example prompts

### Simple workflows

> "Create a workflow that checks Hacker News every weekday at 9am, summarizes the top 15 stories, and posts a brief to Slack"

> "Set up a flow that scrapes https://status.openai.com every hour and logs any changes to my Notion database"

> "Build a workflow that watches for merged PRs in my repo and posts a weekly summary to Slack every Monday morning"

### Multi-source workflows

> "Create a morning crypto brief that pulls RSS from CoinDesk, grabs live market data, and sends a combined summary to Slack at 8am UTC"

> "Set up a flow with three RSS sources — Hacker News, TechCrunch, and The Verge — that runs daily at 7am, filters for AI-related articles, summarizes them, and posts to Notion"

### With keyword filters

> "Make a workflow that pulls from the AWS blog RSS feed every 6 hours, filters for posts mentioning 'Lambda' or 'serverless', and sends matching items to Slack"

### Manual / webhook triggers

> "Create a manual-trigger flow that scrapes a given URL and summarizes the content into bullet points in Slack"

> "Build a webhook-triggered workflow that takes incoming data, processes it through Claude, and pushes the result to Notion"

### Cron variations

> "Set up a flow that checks https://example.com/api/status every 15 minutes and alerts Slack if the content mentions 'degraded' or 'outage'"

> "Create a Saturday morning digest that collects the week's merged PRs from GitHub and posts a changelog to Notion"

### Tips for effective prompts

| Pattern | Why it works |
|---------|-------------|
| Name the cadence | "every weekday at 9am", "every hour", "manual" — maps to cron/manual/webhook triggers |
| Name the source | "RSS from ...", "scrape ...", "GitHub PRs" — maps to source node kinds |
| Describe the processing | "summarize", "filter for keywords", "rewrite as bullet points" — maps to executor prompt |
| Name the destination | "post to Slack", "log to Notion" — maps to sink node kinds |

## Node Structure

Every node in a flow needs these fields:

```json
{
  "id": "t1",
  "node_type": "trigger",
  "kind": "cron",
  "config": { "schedule": "0 9 * * 1-5" },
  "position": { "x": 0, "y": 0 },
  "label": "Weekday 9am"
}
```

- **id** — unique string (e.g. `t1`, `s1`, `e1`, `k1`)
- **node_type** — `trigger` | `source` | `filter` | `executor` | `sink` (lowercase)
- **kind** — variant within the type (e.g. `cron`, `rss`, `claude-code`, `slack`)
- **config** — kind-specific settings (call `get_node_types` for the full schema)
- **position** — `{x, y}` for visual layout; x increases left-to-right (0, 300, 600, 900)
- **label** — human-readable name shown in the Studio UI

## Edge Wiring

Edges connect nodes in the DAG. Each edge needs `{id, source, target}`:

```json
{ "id": "e-t1-s1", "source": "t1", "target": "s1" }
```

Wiring pattern:
- trigger → each source
- each source → executor (or source → filter → executor)
- executor → each sink
- Edge IDs must be unique strings

## Prompt Template Variables

Use these in executor prompts — they're replaced at runtime:

| Variable | Description |
|----------|-------------|
| `{{content}}` | Formatted source items (title, URL, summary) |
| `{{item_count}}` | Number of items after filtering |
| `{{timestamp}}` | Current UTC time |
| `{{market_data}}` | Crypto/market snapshot (requires market-data source) |
| `{{diff}}` | PR diff content (requires github-pr trigger) |
| `{{pr_number}}` | PR number |
| `{{pr_title}}` | PR title |
| `{{repo}}` | Repository in `owner/repo` format |

## Common Configs

```
cron trigger:       { "schedule": "0 9 * * 1-5" }
rss source:         { "url": "https://...", "limit": 10 }
web-scrape source:  { "url": "https://..." }
keyword filter:     { "keywords": ["word1", "word2"], "require_all": false }
claude-code exec:   { "agent_id": "<from list_agents>", "prompt": "Summarize {{content}} into a brief" }
slack sink:         { "webhook_url_env": "SLACK_WEBHOOK_URL" }
notion sink:        { "token_env": "NOTION_TOKEN", "database_id": "uuid" }
```

> **Important:** The `claude-code` executor **must** include an `agent_id`. Call `list_agents` to see available agents.

## Complete Example

RSS feed → Claude summarizer → Slack:

```json
{
  "name": "Tech News Brief",
  "description": "Daily tech news summary to Slack",
  "nodes": [
    {
      "id": "t1", "node_type": "trigger", "kind": "cron",
      "config": { "schedule": "0 9 * * 1-5" },
      "position": { "x": 0, "y": 0 }, "label": "Weekday 9am"
    },
    {
      "id": "s1", "node_type": "source", "kind": "rss",
      "config": { "url": "https://news.ycombinator.com/rss", "limit": 15 },
      "position": { "x": 300, "y": 0 }, "label": "HN RSS"
    },
    {
      "id": "e1", "node_type": "executor", "kind": "claude-code",
      "config": { "agent_id": "mc-content", "prompt": "Summarize the top {{item_count}} tech news items into a brief Slack post with bullet points. Content:\n{{content}}" },
      "position": { "x": 600, "y": 0 }, "label": "Summarizer"
    },
    {
      "id": "k1", "node_type": "sink", "kind": "slack",
      "config": { "webhook_url_env": "SLACK_WEBHOOK_URL" },
      "position": { "x": 900, "y": 0 }, "label": "Slack"
    }
  ],
  "edges": [
    { "id": "e-t1-s1", "source": "t1", "target": "s1" },
    { "id": "e-s1-e1", "source": "s1", "target": "e1" },
    { "id": "e-e1-k1", "source": "e1", "target": "k1" }
  ]
}
```

## Architecture

```
cthulu-mcp/
├── main.rs           # CLI entry point (clap), stdio transport
├── client.rs         # Async HTTP client → Cthulu backend REST API
├── search.rs         # Two-tier web search (SearXNG → DDG fallback)
├── rate_limiter.rs   # Token-bucket rate limiter for DDG fallback
└── tools/
    ├── mod.rs        # Server struct, tool router, parameter types, instructions
    ├── flows.rs      # Flow CRUD + trigger + runs + schedule + file listing
    ├── agents.rs     # Agent CRUD + sessions + chat with polling
    ├── prompts.rs    # Prompt template CRUD
    ├── search.rs     # web_search + fetch_content implementations
    └── utility.rs    # Node schema, templates, cron validation, scheduler, token status
```

The MCP server is a thin client — it proxies all requests to the Cthulu backend REST API at `http://localhost:8081`. No domain logic lives in the MCP layer.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RUST_LOG` | `warn` | Log level for tracing (logs go to stderr) |

CLI args `--base-url` and `--searxng-url` override the backend and SearXNG URLs respectively.

## License

Part of the [Cthulu](https://github.com/saltyskip/cthulu) project.
