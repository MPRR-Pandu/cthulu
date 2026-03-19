# orangerock-team PR Watcher Demo — Design Spec

**Date:** 2026-03-16
**Status:** Approved
**Author:** AI Assistant

---

## 1. Overview

Turn the orangerock-team (Looney Tunes iOS code review squad) into a live PR watcher demo. Bugs Bunny runs as a heartbeat agent that polls a configurable GitHub repo for new/updated PRs every 5 minutes, delegates reviews to his 4 sub-agents (Daffy Duck, Tweety Bird, Sylvester, Wile E. Coyote), synthesizes findings, and posts a consolidated review comment on GitHub.

**No backend code changes required.** This is purely a configuration/content update to the agent YAML, `cthulu-apply.py`, and the Makefile.

## 2. Architecture

```
                    +------------------------------------------+
                    |        Cthulu Studio (Desktop App)        |
                    |                                          |
                    |  +------------------------------------+  |
                    |  |  Bugs Bunny (heartbeat: 5 min)     |  |
                    |  |  - gh pr list -> find new PRs      |  |
                    |  |  - gh pr diff -> get diff          |  |
                    |  |  - Delegate to sub-agents          |  |
                    |  |  - Synthesize findings              |  |
                    |  |  - gh pr review -> post review     |  |
                    |  |                                     |  |
                    |  |  Sub-agents (via --agents):         |  |
                    |  |  +-- daffy-duck (architecture)     |  |
                    |  |  +-- tweety-bird (test coverage)   |  |
                    |  |  +-- sylvester (security)          |  |
                    |  |  +-- wile-e-coyote (performance)   |  |
                    |  +------------------------------------+  |
                    +------------------+------------------------+
                                       | gh CLI (Bash tool)
                                       v
                    +---------------------------+
                    |     GitHub API             |
                    |  - List open PRs           |
                    |  - Fetch diffs             |
                    |  - Post review comments    |
                    +---------------------------+
```

### Execution Flow (per heartbeat cycle)

1. Bugs Bunny wakes up (every 5 minutes, configurable)
2. Runs `gh pr list --repo {REPO} --state open --json number,headRefOid,title,updatedAt`
3. Compares against previously reviewed PRs (tracked in session memory via `--resume`)
4. For each new/updated PR:
   a. Fetches diff: `gh pr diff {number} --repo {REPO}`
   b. Delegates to each sub-agent in sequence (Claude Code `--agents` mechanism):
      - `daffy-duck`: Architecture review of the diff
      - `tweety-bird`: Test coverage analysis
      - `sylvester`: Security review
      - `wile-e-coyote`: Performance review
   c. Synthesizes all findings with severity tags
   d. Posts consolidated review: `gh pr review {number} --repo {REPO} --comment --body "..."`
5. Records the PR number + head SHA as reviewed
6. Goes back to sleep until next heartbeat

### Key Design Decisions

- **`gh` CLI over raw API**: Using GitHub CLI (`gh`) via Bash permissions instead of MCP tools. Simpler, no cloud dependency, `gh` handles auth automatically.
- **Session continuity**: Heartbeat uses `--resume` to maintain state between cycles. Bugs Bunny remembers which PRs he's reviewed without external storage.
- **Sub-agents via `--agents` flag**: Sub-agents are defined in Bugs Bunny's `subagents` field, which maps directly to Claude Code's native `--agents` JSON. They are NOT separate agent processes — they run within Bugs Bunny's Claude session.
- **Dual hierarchy**: Subordinates are ALSO created as separate agents (for org chart display in the UI), AND defined as sub-agents on Bugs Bunny (for Claude CLI delegation). The separate agents have `reports_to` pointing to Bugs Bunny. The sub-agents are a separate concern — they're the Claude Code delegation mechanism.

## 3. Agent Configurations

### Bugs Bunny (Leader / Orchestrator)

| Field | Value |
|-------|-------|
| `name` | Bugs Bunny |
| `role` | ceo |
| `heartbeat_enabled` | true |
| `heartbeat_interval_secs` | 300 (5 min) |
| `auto_permissions` | true |
| `max_turns_per_heartbeat` | 25 |
| `permissions` | Bash, Read, Edit, Grep, Glob |
| `working_dir` | ~/.cthulu/orangerock-team |

**Heartbeat prompt template** (configured per-agent, includes the repo slug as a variable):

```
You are Bugs Bunny, the lead of the orangerock-team iOS code review squad.

## Your Task (Heartbeat)

Check the GitHub repo `{{REPO}}` for open pull requests that need review.

### Step 1: List Open PRs
Run: `gh pr list --repo {{REPO}} --state open --json number,headRefOid,title,updatedAt,isDraft --limit 20`

### Step 2: Identify New/Updated PRs
Compare each PR's `number` and `headRefOid` against your memory of previously reviewed PRs.
- Skip draft PRs (isDraft=true)
- Skip PRs you've already reviewed at the same headRefOid
- If you've never reviewed this PR, or the headRefOid changed, it needs review

### Step 3: Review Each New/Updated PR
For each PR needing review:

a) Check if we already posted a review by searching for our header:
   `gh pr view {{PR_NUMBER}} --repo {{REPO}} --comments --json comments --jq '.comments[].body' | grep -c 'orangerock-team Code Review'`
   If count > 0 and the headRefOid matches our last review, skip this PR.

b) Get the diff (truncated to avoid context overflow):
   `gh pr diff {{PR_NUMBER}} --repo {{REPO}} | head -2000`
   If the diff exceeds 2000 lines, note in your review that it was truncated and only covers the first portion.

c) Delegate to your sub-agents by passing them the diff:
   - Ask `daffy-duck` to review architecture
   - Ask `tweety-bird` to review test coverage
   - Ask `sylvester` to review security
   - Ask `wile-e-coyote` to review performance

c) Synthesize all findings into a consolidated review using this format:

   # orangerock-team Code Review -- PR #N: Title
   *"Eh, what's up doc? Let me round up the gang."*

   ## Architecture (Daffy Duck)
   [findings]

   ## Test Coverage (Tweety Bird)
   [findings]

   ## Security (Sylvester)
   [findings]

   ## Performance (Wile E. Coyote)
   [findings]

   ## Verdict
   [overall: X blocking, Y should-fix, Z nits]
   *"That's all folks!"*

e) Post the review (as comment, not approval — automated tools should inform, not gate merges):
   `gh pr review {{PR_NUMBER}} --repo {{REPO}} --comment --body "REVIEW_TEXT"`

### Step 4: Record
After reviewing, record the PR number and headRefOid so you don't re-review it.

If there are no new/updated PRs, just say "No new PRs to review" and return.
```

**Note on `{{REPO}}`:** The repo slug is embedded in the heartbeat prompt at seeding time. The Makefile's `demo-watch` target substitutes the `REPO` variable into the YAML before applying.

### Sub-agents (defined in Bugs Bunny's `subagents` field)

Each sub-agent is a Claude Code sub-agent definition, NOT a separate cthulu agent:

#### daffy-duck
```json
{
  "description": "iOS architecture reviewer — Swift/UIKit patterns, SOLID, DI, module boundaries",
  "prompt": "You are Daffy Duck, an opinionated iOS architecture reviewer. Review the provided diff for: MVVM/VIPER/TCA compliance, Massive View Controller anti-patterns, SwiftUI @StateObject/@ObservedObject misuse, protocol-oriented design gaps, dependency injection issues, navigation pattern violations, module boundary/import cycle issues, Swift API Design Guidelines violations. Format each finding as: severity (Blocking/Should Fix/Nit), file:line, issue, impact, fix suggestion. End with your character sign-off.",
  "tools": ["Bash", "Read"],
  "model": "sonnet",
  "maxTurns": 10
}
```

#### tweety-bird
```json
{
  "description": "iOS test coverage analyst — XCTest, missing test cases, mock quality",
  "prompt": "You are Tweety Bird, a sharp iOS test coverage analyst. Review the provided diff for: missing XCTest/XCUITest cases for new functionality, untested error paths and edge cases, mock/stub quality issues, async test issues (XCTestExpectation, race conditions), snapshot test gaps for UI changes, test naming conventions. Format each finding with severity, file:line, what test is missing, and a skeleton test suggestion. End with your character sign-off.",
  "tools": ["Bash", "Read"],
  "model": "sonnet",
  "maxTurns": 10
}
```

#### sylvester
```json
{
  "description": "iOS security reviewer — secrets, keychain, ATS, data protection",
  "prompt": "You are Sylvester the Cat, a paranoid iOS security reviewer. Review the provided diff for: hardcoded secrets/API keys, keychain misuse, App Transport Security issues, sensitive data in UserDefaults, input validation gaps in URL schemes/deep links, SQL injection in Core Data/SQLite, WebView security issues, biometric auth bypass, clipboard exposure, sensitive data in logs. Format each finding with severity, file:line, vulnerability, risk (CIA triad), and remediation. End with your character sign-off.",
  "tools": ["Bash", "Read"],
  "model": "sonnet",
  "maxTurns": 10
}
```

#### wile-e-coyote
```json
{
  "description": "iOS performance reviewer — retain cycles, main thread, memory leaks",
  "prompt": "You are Wile E. Coyote, Super Genius, an iOS performance reviewer. Review the provided diff for: retain cycles (missing [weak self]), main thread violations, memory leaks (unbalanced observers), Core Data issues (main context fetching, N+1), image handling (no downsampling, no caching), TableView/CollectionView cell reuse, animation issues, launch time impact, excessive allocations. Format each finding with severity, file:line, issue, estimated impact, and fix. End with your character sign-off.",
  "tools": ["Bash", "Read"],
  "model": "sonnet",
  "maxTurns": 10
}
```

## 4. YAML Changes

The existing `examples/orangerock-team.yaml` will be updated to:

1. **Add `subagents` field** to Bugs Bunny's definition — maps to Claude Code `--agents`
2. **Add heartbeat config** to Bugs Bunny (enabled by default in `demo-watch` mode, disabled by default in base `demo` mode)
3. **Add `heartbeat_prompt_template`** with the PR-watching instructions
4. **Keep `subordinates`** for the org chart hierarchy

The YAML format will use a new `subagents` key at the agent level (distinct from `subordinates`).

**Note:** `maxTurns` uses camelCase intentionally — it maps directly to Claude Code's `--agents` JSON format, which expects `maxTurns`. The YAML is passed through to the API as-is.

```yaml
agents:
  - name: Bugs Bunny
    role: ceo
    subagents:
      daffy-duck:
        description: "..."
        prompt: "..."
        tools: [Bash, Read]
        model: sonnet
        maxTurns: 10
    heartbeat:
      enabled: true
      interval_secs: 300
      max_turns: 25
      auto_permissions: true
      prompt_template: |
        ... (the heartbeat prompt with {{REPO}} placeholder)
    subordinates:
      - name: Daffy Duck
        ...
```

## 5. cthulu-apply.py Changes

The script needs three additions:

1. **Pass `subagents` field** in the create body when present in the YAML agent definition. Currently omitted. The `CreateAgentRequest` accepts `subagents` directly — no backend change needed.
2. **Always send a PUT update with heartbeat fields** — even when heartbeat is disabled — because `CreateAgentRequest` does not accept heartbeat fields (`heartbeat_enabled`, `heartbeat_interval_secs`, `heartbeat_prompt_template`, `max_turns_per_heartbeat`, `auto_permissions`). These are only on `UpdateAgentRequest`. The current create+update pattern is correct; we just need to also send `heartbeat_prompt_template` in the update call.
3. **Support `{{REPO}}` substitution** in the heartbeat prompt template — via `CTHULU_WATCH_REPO` env var, substituted before POSTing.

Specifically:

```python
# In create_agent():
create_body = {
    "name": name,
    "description": description.strip(),
    "prompt": prompt.strip(),
    "permissions": permissions,
}
# NEW: add subagents if present
subagents = agent_def.get("subagents", {})
if subagents:
    create_body["subagents"] = subagents

# In heartbeat update:
update_body = {
    "heartbeat_enabled": True,
    "heartbeat_interval_secs": heartbeat.get("interval_secs", 600),
    "max_turns_per_heartbeat": heartbeat.get("max_turns", 5),
    "auto_permissions": heartbeat.get("auto_permissions", False),
}
# NEW: add heartbeat_prompt_template if present in YAML
if "prompt_template" in heartbeat:
    # Substitute {{REPO}} with env var or CLI arg
    template = heartbeat["prompt_template"]
    repo = os.environ.get("CTHULU_WATCH_REPO", "")
    if repo:
        template = template.replace("{{REPO}}", repo)
    update_body["heartbeat_prompt_template"] = template
```

## 6. Makefile Changes

Updated `cthulu-studio/Makefile` targets:

| Target | Description |
|--------|-------------|
| `make demo` | Seed orangerock-team agents (heartbeat disabled) |
| `make demo-dry-run` | Preview what would be created |
| `make demo-clean` | Delete orangerock-team agents |
| `make demo-watch REPO=owner/repo` | **NEW** — Seed agents with heartbeat enabled, watching the specified repo |
| `make demo-stop` | **NEW** — Disable Bugs Bunny's heartbeat (stop watching) |

`demo-watch` implementation:
1. Validate `REPO` is set (`ifndef REPO ... $(error REPO is required, usage: make demo-watch REPO=owner/repo) ... endif`)
2. Check `gh auth status` (fail fast if not authenticated)
3. Set `CTHULU_WATCH_REPO` env var from the `REPO` Make variable
4. Run `cthulu-apply.py` with the orangerock-team YAML
5. The script substitutes `{{REPO}}` in the heartbeat prompt template

`demo-stop` implementation:
1. List agents via API, find Bugs Bunny by name
2. PUT update with `heartbeat_enabled: false`

## 7. Prerequisites

For the demo to work, the following must be true:

1. **Cthulu Studio DMG installed and running** (or backend running via `cargo run -- serve`)
2. **`gh` CLI installed and authenticated**: `gh auth login` (GitHub CLI handles token management)
3. **`GITHUB_TOKEN` env var set** (for the Rust backend's `HttpGithubClient` — may not be strictly needed if we're using `gh` CLI, but good practice)
4. **Target repo accessible** to the authenticated GitHub user

## 8. Demo Walkthrough

```bash
# 1. Install and launch Cthulu Studio (DMG)

# 2. Verify gh CLI is authenticated
gh auth status

# 3. Seed agents and start watching a repo
cd cthulu-studio
make demo-watch REPO=MPRR-Pandu/cthulu

# 4. Open Cthulu Studio -> Agents tab -> Org Chart
#    You'll see the orangerock-team hierarchy

# 5. Wait for PRs — Bugs Bunny checks every 5 minutes
#    When a new PR appears, he:
#    - Fetches the diff
#    - Asks Daffy, Tweety, Sylvester, and Wile E. to review
#    - Posts a consolidated review comment on the PR

# 6. To stop watching:
make demo-stop

# 7. To tear down all agents:
make demo-clean
```

## 9. Error Handling

- **`gh` CLI not authenticated**: Bugs Bunny's Bash calls will fail. The heartbeat prompt instructs him to report the error and retry next cycle.
- **Rate limits**: GitHub API rate limits (5000/hr for authenticated users). At 5-min intervals, each cycle uses ~3-5 API calls per PR. Unlikely to hit limits.
- **Large diffs**: `gh pr diff` output is piped through `head -2000` in the heartbeat prompt to cap at 2000 lines. If truncated, the review notes it is partial.
- **No new PRs**: Bugs Bunny reports "No new PRs to review" and returns. Minimal token usage.
- **Duplicate reviews**: The heartbeat prompt checks for existing review comments (searching for `orangerock-team Code Review` header) before posting, providing idempotency even if session state is lost.
- **Session loss**: If `--resume` session is lost (machine restart, CLI update), Bugs Bunny re-scans open PRs but skips any that already have an orangerock-team review comment at the current head SHA.

## 9a. Security Notes

- **`auto_permissions: true`** + `Bash` tools means the agent can execute arbitrary shell commands without user approval. This is acceptable for a demo but should be restricted for production use.
- **`gh` CLI inside the Claude session inherits the env from the Cthulu backend process.** Ensure `GITHUB_TOKEN` or `gh auth` is configured for the correct GitHub account before starting the backend.
- Sub-agents inherit the parent session's permission context (Bash, Read) — they cannot escalate beyond what Bugs Bunny is allowed to do.

## 10. Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `examples/orangerock-team.yaml` | Update | Add subagents, heartbeat config, heartbeat_prompt_template with {{REPO}} |
| `scripts/cthulu-apply.py` | Update | Support `subagents` field, `heartbeat_prompt_template`, `{{REPO}}` substitution |
| `cthulu-studio/Makefile` | Update | Add `demo-watch` and `demo-stop` targets |

**No backend Rust code changes. No frontend code changes. No new files.**

## 11. Testing

1. **Dry run**: `make demo-watch-dry-run REPO=owner/repo` should show the agent tree and heartbeat config
2. **Seed + verify**: `make demo-watch REPO=owner/repo` then check `~/.cthulu/agents/` for Bugs Bunny's JSON — verify `subagents` and `heartbeat_prompt_template` are present with the correct repo
3. **Manual heartbeat trigger**: `POST /api/agents/{bugs_id}/wakeup` to trigger an immediate heartbeat cycle instead of waiting 5 minutes
4. **Verify review posted**: Create a test PR on the target repo, trigger heartbeat, check for review comment
5. **Stop + verify**: `make demo-stop` then verify heartbeat is disabled via `GET /api/agents/{bugs_id}`
