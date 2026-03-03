// Node type definitions for the NLP workflow builder
// Ported from cthulu-mcp/tools/utility.rs NODE_SCHEMA

export interface ConfigField {
  name: string;
  type: "string" | "number" | "boolean" | "string[]";
  required: boolean;
  default?: unknown;
  description?: string;
}

export interface NodeKindSchema {
  kind: string;
  description: string;
  configFields: ConfigField[];
}

export interface NodeTypeSchema {
  nodeType: "trigger" | "source" | "filter" | "executor" | "sink";
  kinds: NodeKindSchema[];
}

export const NODE_SCHEMA: NodeTypeSchema[] = [
  // ── trigger ──────────────────────────────────────────────────────────
  {
    nodeType: "trigger",
    kinds: [
      {
        kind: "cron",
        description: "Run on a cron schedule",
        configFields: [
          { name: "schedule", type: "string", required: true, description: "5-field cron expression" },
          { name: "working_dir", type: "string", required: false, default: ".", description: "Working directory" },
        ],
      },
      {
        kind: "github-pr",
        description: "Trigger on GitHub pull request events",
        configFields: [
          { name: "repo", type: "string", required: true, description: "GitHub repo (owner/repo)" },
          { name: "working_dir", type: "string", required: false, default: ".", description: "Working directory" },
        ],
      },
      {
        kind: "webhook",
        description: "Trigger via incoming webhook",
        configFields: [
          { name: "working_dir", type: "string", required: false, default: ".", description: "Working directory" },
        ],
      },
      {
        kind: "manual",
        description: "Trigger manually from the UI",
        configFields: [
          { name: "working_dir", type: "string", required: false, default: ".", description: "Working directory" },
        ],
      },
    ],
  },

  // ── source ───────────────────────────────────────────────────────────
  {
    nodeType: "source",
    kinds: [
      {
        kind: "rss",
        description: "Fetch items from an RSS feed",
        configFields: [
          { name: "url", type: "string", required: true, description: "RSS feed URL" },
          { name: "limit", type: "number", required: false, default: 20, description: "Maximum items to fetch" },
          { name: "keywords", type: "string[]", required: false, description: "Filter keywords" },
        ],
      },
      {
        kind: "web-scrape",
        description: "Scrape a web page for content",
        configFields: [
          { name: "url", type: "string", required: true, description: "Page URL to scrape" },
          { name: "keywords", type: "string[]", required: false, description: "Filter keywords" },
        ],
      },
      {
        kind: "web-scraper",
        description: "Structured web scraping with CSS selectors",
        configFields: [
          { name: "url", type: "string", required: true, description: "Page URL to scrape" },
          { name: "items_selector", type: "string", required: true, description: "CSS selector for items" },
          { name: "title_selector", type: "string", required: true, description: "CSS selector for title" },
          { name: "url_selector", type: "string", required: true, description: "CSS selector for URL" },
        ],
      },
      {
        kind: "github-merged-prs",
        description: "Fetch recently merged pull requests",
        configFields: [
          { name: "repos", type: "string[]", required: true, description: "List of repos (owner/repo)" },
          { name: "since_days", type: "number", required: false, default: 7, description: "Look back N days" },
        ],
      },
      {
        kind: "market-data",
        description: "Fetch BTC/ETH/S&P/Fear&Greed market data",
        configFields: [],
      },
      {
        kind: "google-sheets",
        description: "Read data from Google Sheets",
        configFields: [
          { name: "spreadsheet_id", type: "string", required: true, description: "Google Sheets spreadsheet ID" },
          { name: "range", type: "string", required: true, default: "Sheet1!A1:Z100", description: "Cell range" },
          { name: "service_account_key_env", type: "string", required: true, description: "Env var holding service account key" },
          { name: "limit", type: "number", required: false, default: 100, description: "Maximum rows to fetch" },
        ],
      },
    ],
  },

  // ── filter ───────────────────────────────────────────────────────────
  {
    nodeType: "filter",
    kinds: [
      {
        kind: "keyword",
        description: "Filter items by keyword matching",
        configFields: [
          { name: "keywords", type: "string[]", required: true, description: "Keywords to match" },
          { name: "mode", type: "string", required: false, default: "any", description: "Match mode: 'any' or 'all'" },
          { name: "field", type: "string", required: false, default: "title", description: "Field to search: 'title' or 'content'" },
        ],
      },
    ],
  },

  // ── executor ─────────────────────────────────────────────────────────
  {
    nodeType: "executor",
    kinds: [
      {
        kind: "claude-code",
        description: "Execute a prompt with Claude Code",
        configFields: [
          { name: "prompt", type: "string", required: true, description: "Inline text or path to prompt.md" },
          { name: "permissions", type: "string[]", required: false, default: ["Bash", "Read", "Grep", "Glob"], description: "Allowed tool permissions" },
          { name: "working_dir", type: "string", required: false, default: ".", description: "Working directory" },
        ],
      },
      {
        kind: "vm-sandbox",
        description: "Execute in an isolated VM sandbox",
        configFields: [
          { name: "working_dir", type: "string", required: false, default: ".", description: "Working directory" },
        ],
      },
    ],
  },

  // ── sink ──────────────────────────────────────────────────────────────
  {
    nodeType: "sink",
    kinds: [
      {
        kind: "slack",
        description: "Send output to Slack",
        configFields: [
          { name: "webhook_url_env", type: "string", required: false, default: "SLACK_WEBHOOK_URL", description: "Env var for Slack webhook URL" },
          { name: "bot_token_env", type: "string", required: false, default: "SLACK_BOT_TOKEN", description: "Env var for Slack bot token" },
          { name: "channel", type: "string", required: false, default: "#general", description: "Slack channel" },
        ],
      },
      {
        kind: "notion",
        description: "Write output to a Notion database",
        configFields: [
          { name: "token_env", type: "string", required: true, description: "Env var for Notion token" },
          { name: "database_id", type: "string", required: true, description: "Notion database UUID" },
        ],
      },
    ],
  },
];

// ── Helper functions ─────────────────────────────────────────────────────

/** Get all kinds for a given node type. */
export function getNodeKinds(nodeType: string): NodeKindSchema[] {
  const entry = NODE_SCHEMA.find((s) => s.nodeType === nodeType);
  return entry?.kinds ?? [];
}

/** Get config fields for a specific node type + kind combination. */
export function getConfigFields(nodeType: string, kind: string): ConfigField[] {
  const kinds = getNodeKinds(nodeType);
  const kindSchema = kinds.find((k) => k.kind === kind);
  return kindSchema?.configFields ?? [];
}

/** Check whether a connection from sourceType → targetType is valid. */
export function isValidConnection(sourceType: string, targetType: string): boolean {
  const allowed = EDGE_RULES[sourceType];
  return allowed ? allowed.includes(targetType) : false;
}

// ── Edge wiring rules ────────────────────────────────────────────────────

export const EDGE_RULES: Record<string, string[]> = {
  trigger: ["source", "executor"],
  source: ["executor", "filter"],
  filter: ["executor"],
  executor: ["sink"],
};

// ── Prompt template variables reference ──────────────────────────────────

export const TEMPLATE_VARIABLES = [
  { name: "content", description: "Formatted source items" },
  { name: "item_count", description: "Number of items fetched" },
  { name: "timestamp", description: "Current UTC timestamp" },
  { name: "market_data", description: "Crypto/market snapshot (only with market-data source)" },
  { name: "diff", description: "PR diff (only with github-pr trigger)" },
  { name: "pr_number", description: "GitHub PR number" },
  { name: "pr_title", description: "GitHub PR title" },
  { name: "repo", description: "GitHub repo (owner/repo)" },
];
