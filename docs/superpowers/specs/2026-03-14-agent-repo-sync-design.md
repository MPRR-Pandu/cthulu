# Phase 3: Agent Repo Sync — Design Spec

**Date:** 2026-03-14
**Status:** Approved
**Approach:** Mirror the workflow sync pattern (Approach A)

## Overview

Add GitHub repo sync for agent definitions. Agents can be published to a private `cthulu-agents` GitHub repo organized by project, and synced across machines. This mirrors the existing `cthulu-workflows` pattern using pure REST (GitHub Contents API via `reqwest`).

## Data Model

### Agent Struct Change

Add one field to the `Agent` struct in `cthulu-backend/agents/mod.rs`:

```rust
pub project: Option<String>,  // e.g., "my-app", None = local-only
```

- `None` = agent is local-only, not synced to GitHub
- `Some("project-name")` = agent belongs to this project and can be published
- Default: `None` (backward compatible with existing agents)

The `AgentBuilder` (typestate builder in the same file) must also be updated:
- Add `project: Option<String>` field to `AgentBuilder<S>` struct
- Initialize to `None` in `Agent::builder()`
- Add `.project(name: impl Into<String>)` setter method
- Carry through the `.name()` transition and `.build()`

### AgentSummary Changes

The backend `list_agents` Tauri command returns `AgentSummary` objects (subset of Agent fields). The `project` field must flow through:

- **Rust side**: Ensure the `AgentSummary` serialization (in `commands/agents.rs`) includes `project`
- **TypeScript side**: Add `project?: string` to the `AgentSummary` interface in `types/flow.ts`

This is required for the sidebar to group agents by project.

### Project Name Validation

Project names must be valid as both filesystem directory names and GitHub path segments. Allowed characters: lowercase alphanumeric and hyphens (`[a-z0-9-]+`). No spaces, underscores, or special characters.

### GitHub Repo Structure

Repo name: `cthulu-agents` (private, created by setup command)

```
cthulu-agents/
  projects/
    <project>/
      agents/
        <agent-id>/
          agent.json     # All Agent fields EXCEPT prompt
          prompt.md      # Prompt content (extracted from prompt field)
```

### Local Directories

Two separate directories for agents:

| Directory | Purpose |
|-----------|---------|
| `~/.cthulu/agents/` | **Runtime store** — flat `{id}.json` files, existing `FileAgentRepository`, unchanged |
| `~/.cthulu/cthulu-agents/` | **Sync mirror** — matches GitHub repo structure, written by publish/sync commands only |

### File Formats

**agent.json** (in sync dir / GitHub):
All `Agent` struct fields serialized to JSON, except:
- `prompt` field is omitted (stored in `prompt.md` instead)
- `project` field is derived from the directory path, not stored in the JSON

**prompt.md** (in sync dir / GitHub):
Raw text content of the agent's `prompt` field.

**{id}.json** (in runtime dir):
Full `Agent` JSON with prompt inline — existing format, unchanged.

## Data Flows

### Publish Agent

```
1. Read agent from runtime store (~/.cthulu/agents/{id}.json)
2. Split: extract prompt → prompt.md, remainder → agent.json
3. Write to sync dir (~/.cthulu/cthulu-agents/projects/{project}/agents/{id}/)
4. Push both files to GitHub via Contents API (PUT with base64 content)
```

### Sync Agents (Pull)

```
1. Fetch full repo tree from GitHub Contents API (recursive)
2. Download all files to sync dir (~/.cthulu/cthulu-agents/)
3. For each agent dir found (projects/{project}/agents/{id}/):
   a. Read agent.json + prompt.md
   b. Merge prompt.md content into agent.json's prompt field
   c. Set project = <project-name> from path
   d. Write combined Agent JSON to runtime store (~/.cthulu/agents/{id}.json)
4. Call agent_repo.load_all() to refresh in-memory cache
```

### Local Save (Unchanged)

```
1. Write to runtime store only (~/.cthulu/agents/{id}.json)
2. No sync dir write, no GitHub push
```

## API: Tauri Commands

New file: `cthulu-studio/src-tauri/src/commands/agent_repo.rs`

| Command | Params | Returns | Description |
|---------|--------|---------|-------------|
| `setup_agent_repo` | — | `()` | Read PAT from `AppState.github_pat` via `require_pat()`. Create `cthulu-agents` private repo on GitHub, sync to local, save owner in `secrets.json` under `agent_repo.owner` |
| `sync_agent_repo` | — | `()` | Pull all from GitHub → sync dir → merge into runtime `~/.cthulu/agents/` → reload |
| `list_agent_projects` | — | `Vec<String>` | List project directories from `~/.cthulu/cthulu-agents/projects/` |
| `create_agent_project` | `project: String` | `()` | Create project directory + `.gitkeep` in sync dir and GitHub |
| `publish_agent` | `id: String, project: String` | `()` | Split → sync dir → GitHub. Updates agent's `project` field in runtime store. |
| `unpublish_agent` | `id: String` | `()` | Delete from sync dir + GitHub. Clears `project` field in runtime store. |

All commands follow existing patterns:
- Call `crate::wait_ready(&ready).await?` at start
- Return `Result<T, String>` (Tauri convention)
- Use flat params (not struct wrappers)

### Frontend API (client.ts)

```typescript
setupAgentRepo(): Promise<void>
syncAgentRepo(): Promise<void>
listAgentProjects(): Promise<string[]>
createAgentProject(project: string): Promise<void>
publishAgent(id: string, project: string): Promise<void>
unpublishAgent(id: string): Promise<void>
```

## GitHub API Helpers

Inline in `agent_repo.rs`, mirroring `workflows/handlers.rs`:

- `github_contents(client, pat, owner, path)` — GET file/directory from Contents API
- `github_put_file(client, pat, owner, path, content, message)` — Create/update file (auto-fetches SHA for updates, base64 encodes)
- `github_delete_file(client, pat, owner, path, message)` — Delete file (GET SHA first, then DELETE)
- `sync_repo_to_local(client, pat, owner, base_path, local_dir)` — Recursive download

Constants:
```rust
const REPO_NAME: &str = "cthulu-agents";
const SECRETS_KEY: &str = "agent_repo";
```

## Frontend UI Changes

### Agent Editor (AgentEditor.tsx)

1. **Project selector dropdown** — Top of editor. Options from `listAgentProjects()` + "Create new project..." Changing sets the agent's `project` field.

2. **Publish button** — In top bar next to Save. Disabled if no project selected. Calls `publishAgent(id, project)`. Shows success/error toast.

3. **Sync status badge** — Next to agent name:
   - No badge = local only (`project = None`)
   - Green checkmark = published
   - Orange dot = local changes not yet published (compare `updated_at` with last publish time — stretch goal, can omit in v1)

### Sidebar (Sidebar.tsx) — Agent List Grouping

Group agents by project:
```
Agents
  ├─ my-app
  │   ├─ code-reviewer
  │   └─ bugs-bunny
  ├─ another-project
  │   └─ tweety-bird
  └─ Local Only
      └─ studio-assistant
```

Agents with `project = None` grouped under "Local Only" at the bottom.

### Setup Flow

On first "Publish" attempt, if `secrets.json` has no `agent_repo.owner` key:
1. If `AppState.github_pat` is empty (no PAT from workflow setup), prompt for GitHub PAT first via existing `save_github_pat` flow
2. Call `setupAgentRepo()` (no params — reads PAT from AppState)
3. Show confirmation with repo URL

Alternatively, accessible via Settings.

### Global Sync Button

"Sync Agents" button in sidebar header or settings. Calls `syncAgentRepo()`.

## Error Handling

| Scenario | Handling |
|----------|----------|
| No PAT configured | Publish/sync return error: "Agent repo not set up" |
| PAT expired/invalid | Surface 401: "GitHub token expired" |
| Repo deleted externally | `sync` gets 404 → prompt re-setup |
| Agent has no project | Publish button disabled |
| Network offline | GitHub calls fail → surface error, local save unaffected |
| Conflicting agent IDs | Agent IDs are globally unique. On sync, if same ID in different projects, warn and skip the duplicate. |
| `studio-assistant` | Built-in, filtered from publish UI |
| Subagent-only agents | Can be published normally |

## File Watcher Integration

- Existing `FileChangeWatcher` watches `~/.cthulu/agents/` — handles runtime store changes
- Use existing `mark_self_write` / `consume_self_write` on `FileAgentRepository` during sync writes
- No new watcher needed for `~/.cthulu/cthulu-agents/` — only modified by our commands

## Secrets Storage

```json
// ~/.cthulu/secrets.json
{
  "workspace_repo": { "owner": "username" },
  "agent_repo": { "owner": "username" }
}
```

Same PAT (`AppState.github_pat`) for both repos — same GitHub account.

## Sync Strategy

**Last-write-wins.** Publish always overwrites GitHub. Sync always overwrites local. Users rely on git history for recovery. No merge conflict detection in v1.

## Files to Create

| File | Purpose |
|------|---------|
| `cthulu-studio/src-tauri/src/commands/agent_repo.rs` | All Tauri commands + GitHub API helpers |

## Files to Modify

| File | Changes |
|------|---------|
| `cthulu-backend/agents/mod.rs` | Add `project: Option<String>` to `Agent` struct + `AgentBuilder` (field, setter, carry-through) |
| `cthulu-studio/src-tauri/src/commands/mod.rs` | Add `pub mod agent_repo;` |
| `cthulu-studio/src-tauri/src/main.rs` | Register 6 new commands in `generate_handler![]` |
| `cthulu-studio/src/api/client.ts` | Add 6 new API functions |
| `cthulu-studio/src/components/AgentEditor.tsx` | Project selector, publish button, sync badge |
| `cthulu-studio/src/components/Sidebar.tsx` | Group agents by project |
| `cthulu-studio/src/types/flow.ts` | Add `project?: string` to both `Agent` and `AgentSummary` TypeScript interfaces |
| `cthulu-studio/src-tauri/src/commands/agents.rs` | Ensure `list_agents` response includes `project` field in serialized summary |

## Out of Scope (v1)

- Sync status tracking (published vs. unpublished changes) — show badge but don't track timestamps
- Automatic sync on startup — manual sync only
- Webhooks for push notifications from GitHub
- Multi-repo support (one repo per user)
- Agent versioning beyond git history
