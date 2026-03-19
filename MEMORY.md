# Cthulu -- Session Memory

> **THE RULE: Small changes at once per PR.** One concern per PR. ~2 files / ~100 lines threshold. Decompose larger work into the smallest independent PRs possible. Never bundle unrelated changes.

---

## What Is Cthulu

AI-powered workflow automation system. Orchestrates Claude Code agents in directed-acyclic-graph (DAG) pipelines. Connects triggers -> sources -> filters -> executors (Claude Code) -> sinks.

**Monorepo** (Nx 20.8) with 3 projects:

| Project | Tech | Port | Purpose |
|---------|------|------|---------|
| `cthulu` (backend) | Rust 2024, Axum 0.8, Tokio | 8081 | Flow runner, scheduler, REST API |
| `cthulu-studio` | React 19, TypeScript, Vite 7, React Flow 12, Tauri 2 | 5173 | Visual flow editor, agent chat, desktop app |
| `cthulu-site` | Next.js 15, Tailwind 4, Framer Motion | 3000 | Marketing website |

Shared package: `@cthulu/brand` (palette, theme tokens).

---

## PR Discipline (CRITICAL)

- **One PR per task. Small changes only.**
- ~2 files / ~100 lines per PR threshold
- Split into smallest independent PRs
- Never bundle unrelated changes
- Each PR should be reviewable in under 10 minutes
- Prefer many small PRs over one large PR

---

## Architecture Summary

### Backend (`cthulu-backend/`)

- **Entry**: `main.rs` (clap CLI) -> `cargo run -- serve`
- **Config**: `config.rs` (env-based, dotenvy)
- **API**: Vertical slice architecture in `api/` -- each domain has `mod.rs` (router) + `routes.rs` (handlers)
  - Slices: `flows/`, `agents/`, `prompts/`, `templates/`, `scheduler/`, `hooks/`, `auth/`
  - Merged in `api/routes.rs::build_router()`
  - Shared types in `api/mod.rs` (AppState with ~20 Arc fields)
- **Domain models**:
  - `Flow` (id, name, nodes[], edges[], version for optimistic concurrency)
  - `Node` (id, node_type: Trigger|Source|Executor|Sink, kind, config: serde_json::Value)
  - `Agent` (id, name, prompt, permissions[], hooks, subagents) -- typestate builder pattern
  - `NodeOutput` (Items|Text|Context|Empty|Failed) -- merges across DAG edges
- **Repositories**: Trait-based (`FlowRepository`, `AgentRepository`, `PromptRepository`) with `FileXxxRepository` implementations (JSON on disk in `~/.cthulu/`)
- **Pipeline**: `flows/runner.rs` does topological sort -> level-by-level parallel execution -> node dispatch via `processors.rs`
- **Scheduler**: `flows/scheduler.rs` -- cron loops (croner) and GitHub PR polling
- **Executors**: `ClaudeCodeExecutor` (host CLI, stream-json) and `SandboxExecutor` (VM)
- **Sources**: RSS, web-scrape, web-scraper (CSS selectors), github-merged-prs, google-sheets, market-data
- **Sinks**: Slack (webhook + Bot API with Block Kit), Notion (markdown -> blocks)
- **Sandbox**: `SandboxProvider` trait -> VmManagerProvider (production), DangerousHostProvider, FirecrackerProvider
- **Real-time**: broadcast channels for RunEvents (SSE), ResourceChangeEvents, session streams, permission hooks
- **File watcher**: `watcher.rs` watches `~/.cthulu/` for external edits, reloads in-memory cache
- **Agent SDK**: Experimental `agent_sdk/` module (claude-agent-sdk-rust crate)

### Studio (`cthulu-studio/`)

- **Root**: `App.tsx` -- manages flows, agents, prompts, views (`flow-editor` | `agent-workspace` | `prompt-editor`)
- **State**: No external library. `useFlowDispatch` hook (canonical flow + UpdateSignal pattern + debounced auto-save + optimistic concurrency). `useGlobalPermissions` hook (SSE for permission requests). `useAgentChat` hook (SSE streaming chat).
- **Canvas**: `Canvas.tsx` with `CanvasHandle` imperative API (forwardRef). Connection validation (only valid node-type pairs). Two-way data bridge (Flow <-> React Flow types).
- **Components**: TopBar, Sidebar (Flows/Agents/Prompts + node palette), Canvas, NodeConfigPanel, FlowEditor (Monaco), RunLog, AgentChatView, FileViewer, ChangesPanel, DebugPanel, TemplateGallery
- **API client**: `api/client.ts` -- `apiFetch<T>()` wrapper, typed endpoints for all domains
- **SSE**: `interactStream.ts` (fetch + ReadableStream for chat) and `runStream.ts` (EventSource for run events)
- **Chat**: `@assistant-ui/react` primitives, SSE event parsing, image attachments, git snapshot context
- **Theming**: CSS variables from `@cthulu/brand` palette, ThemeContext, multiple themes (eldritch dark/light, cosmic dark/light)
- **Validation**: `validateNode.ts` -- per-kind config validation for all node types

### Site (`cthulu-site/`)

- Next.js 15 App Router, server components by default
- Landing page sections: Nav, Hero, ValueProps, MultiAgent, UseCases, HowItWorks, StudioShowcase, ConfigExample, FlowDemo (interactive React Flow), GetStarted, Footer
- Shared brand tokens from `@cthulu/brand`

---

## Critical Rules (Must Follow)

1. **React Flow node merging**: NEVER replace nodes wholesale (`setNodes(newArray)`). Always spread-merge: `{ ...existingNode, data: newData }`. Wholesale replacement destroys `measured`/`internals`/`handleBounds`.
2. **No `useEffect` for derived state**: Use `useMemo`, callback state setters, event handlers. Only `useEffect` for syncing external props.
3. **Axum path params**: Use `{param}` syntax, NOT `:param`.
4. **Restart server after Rust changes**: No hot-reload.
5. **`tokio::sync::Mutex`** for async contexts (not `std::sync::Mutex`).
6. **Never derive Clone on process handles**: `ChildStdin`, `Child`, `mpsc::Receiver` are not Clone. Use `Arc<Mutex<...>>`. `AppState` MUST derive Clone.
7. **SSE streams**: `async_stream::stream!` -- nothing between `};` and return. Delete orphaned code.
8. **Session keys**: `agent::{agent_id}` -- agent-scoped, not flow-scoped.
9. **Atomic YAML persistence**: temp file + rename pattern.
10. **Claude CLI stream-json**: `{"type":"user","message":{"role":"user","content":"..."}}` with `--verbose`.
11. **Manual Run always works**: Even when flow is disabled (manual override).
12. **Plan-First**: Explore, plan, approve, execute for non-trivial tasks.
13. **Verify Before Done**: `cargo check` (Rust), `npx nx build cthulu-studio` (Studio), `npx nx build cthulu-site` (Site).
14. **Shell injection prevention**: Never interpolate user input into shell commands. Use single-quote-with-replacement escape.
15. **Default-deny capabilities**: Everything starts disabled.

---

## Essential Commands

| Task | Command |
|------|---------|
| Start backend + Studio | `npm run dev` |
| Start all projects | `npm run dev:all` |
| Build Rust backend | `npx nx build cthulu` |
| Dev Rust backend | `npx nx dev cthulu` or `cargo run -- serve` |
| Check Rust compiles | `cargo check` |
| Lint Rust | `cargo clippy -- -D warnings` |
| Test Rust | `cargo test` |
| Build Studio | `npx nx build cthulu-studio` |
| Dev Studio | `npx nx dev cthulu-studio` |
| Build Site | `npx nx build cthulu-site` |
| Dev Site | `npx nx dev cthulu-site` |

---

## Verification Checklist

| Change Type | Verify With |
|-------------|-------------|
| Rust backend | `cargo check` |
| Studio frontend | `npx nx build cthulu-studio` |
| Site | `npx nx build cthulu-site` |
| Sandbox changes | `cargo test sandbox && cargo check` |
| Full stack | Both Rust and Studio builds |

---

## Key File Locations

| What | Where |
|------|-------|
| Backend entry | `cthulu-backend/main.rs` |
| AppState + shared types | `cthulu-backend/api/mod.rs` |
| Router composition | `cthulu-backend/api/routes.rs` |
| Flow model | `cthulu-backend/flows/mod.rs` |
| Flow runner (DAG) | `cthulu-backend/flows/runner.rs` |
| Scheduler | `cthulu-backend/flows/scheduler.rs` |
| Pipeline orchestration | `cthulu-backend/tasks/pipeline.rs` |
| Agent model | `cthulu-backend/agents/mod.rs` |
| Agent chat SSE | `cthulu-backend/api/agents/chat.rs` |
| Claude Code executor | `cthulu-backend/tasks/executors/claude_code.rs` |
| Sources | `cthulu-backend/tasks/sources/` |
| Sinks | `cthulu-backend/tasks/sinks/` |
| Studio root | `cthulu-studio/src/App.tsx` |
| Canvas | `cthulu-studio/src/components/Canvas.tsx` |
| API client | `cthulu-studio/src/api/client.ts` |
| TS types | `cthulu-studio/src/types/flow.ts` |
| Node validation | `cthulu-studio/src/utils/validateNode.ts` |
| Brand palette | `packages/brand/palette.ts` |
| Workflow templates | `static/workflows/` |
| Example flows | `examples/` |
| Prompt templates | `examples/prompts/` |
| Lessons learned | `.claude/lessons.md` |
| Dead ends | `NOPE.md` |
| Troubleshooting | `docs/TROUBLESHOOTING.md` |

---

## Common Gotchas

1. **FlowRunner has 7+ construction sites** -- 4 in `flows/` routes, 3+ in `scheduler.rs`. Update all when changing FlowRunner fields.
2. **OAuth token injection**: Must write ALL 6 credential fields. `.bashrc` must replace, not skip-if-present.
3. **`useDeferredValue` consistency**: All dependent UI must read from the same deferred value.
4. **npm hoisting**: If package A is hoisted, its dependencies must also be at root level.
5. **Nested KVM on Apple Silicon**: DOES NOT WORK. Use VM Manager API on real Linux server.
6. **`isAuthError` pattern matching**: Match "401 Unauthorized", not bare "401" (false positives from PR numbers/ports).
7. **`display: flex` breaks Fragment children**: Use wrapper divs.
8. **`FsJail`**: Don't use `canonicalize()` (fails on non-existent paths, macOS `/var` -> `/private/var`).

---

## Data Persistence

- Flows: JSON files in `~/.cthulu/flows/`
- Agents: JSON files in `~/.cthulu/agents/`
- Prompts: JSON files in `~/.cthulu/prompts/`
- Sessions: `~/.cthulu/sessions.yaml` (atomic write)
- Live processes: In-memory pool (keyed by `agent::{agent_id}`)
- Run history: Stored per-flow in the flow repository

---

## CI/CD

- Single GitHub Actions workflow: `code-review-agent.yml`
- Uses GPT-4o-mini for automated PR code review
- Triggers on PRs to `main`, skips Dependabot
- Idempotent comments (updates existing review on force-push)

---

## Dead Ends (Don't Retry)

1. Nested KVM on Apple Silicon (Lima/QEMU/UTM) -- hardware limitation
2. `mknod /dev/kvm` inside Lima -- kernel driver non-functional
3. Firecracker without KVM -- hard requirement, no fallback
4. Proxying ttyd WebSocket through Cthulu -- use direct iframe instead
5. SSH exec from Cthulu to VM Manager VMs -- VMs are interactive-only
6. Downcasting `Arc<dyn SandboxProvider>` -- store specific provider separately

---

## UI Styling Rules (ref: feat/cloud-workflows-studio)

### Dropdowns
- Trigger: `padding: 0 12px`, height 32px, `border-radius: 8px`
- Viewport: `padding: 8px`
- Items: `padding: 6px 12px`, font-size 12px

### Dialogs / Popups
- Content: `padding: 24px`, `gap: 16px`, `border-radius: 8px`, max-width 400-440px
- Inputs: `padding: 8px 10px`, font-size 13px, `border-radius: 4px`
- Buttons: `padding: 6px 14px`, font-size 13px
- Labels: font-size 12px, `color: var(--text-secondary)`

### TopBar Nav Tabs
- Underline style: `border-bottom: 2px solid transparent`, active = `var(--accent)`
- `padding: 4px 12px`, font-size 13px, gap 4px

### Tokens
`--space-1: 4px` `--space-2: 8px` `--space-3: 12px` `--space-4: 16px` `--space-6: 24px` `--radius: 8px` `--text-xs: 11px` `--text-sm: 13px`
