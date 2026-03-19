# Cthulu Dashboard Feature - Context Index

## Project Overview
- **Cthulu**: AI-powered workflow automation system (Nx monorepo)
- **cthulu-backend**: Rust/Axum, port 8081 — flow runner, scheduler, REST API
- **cthulu-studio**: React 19/Vite, port 5173 — visual flow editor, agent chat, **dashboard lives here**
- **cthulu-site**: Next.js 15, port 3000 — static marketing page only (no dashboard)

## Feature Requirements (Decided)
1. **Target**: cthulu-studio (not cthulu-site)
2. **Thread messages**: Fetch ALL thread replies for every message with a thread
3. **AI Summary**: Per-channel summary (each channel gets its own Claude-generated summary)
4. **Approach**: Messages show instantly, summaries load async (Approach A)

## What Was Built

### Layer 1: Python Sidecar (`scripts/slack_messages.py`)
- Added `--with-threads` CLI flag
- Added `fetch_thread_replies()` method using `conversations.replies` API
- Thread replies nested inside parent messages as `replies` array
- Rate limiting: `time.sleep(0.4)` between thread fetches

### Layer 2: Rust Backend (`cthulu-backend/api/dashboard/`)
- `handlers.rs`: Added `--with-threads` to the Python command args
- `handlers.rs`: Added `POST /api/dashboard/summary` endpoint — spawns Claude CLI with channel messages, returns per-channel summaries
- `mod.rs`: Registered the new `/dashboard/summary` route
- Claude CLI pattern: `claude --print --allowedTools "" -` with prompt on stdin (same as prompts/handlers.rs)

### Layer 3: Frontend (`cthulu-studio/`)
- `api/client.ts`: Added `SlackMessage.thread_ts/reply_count/replies` fields, `ChannelSummary`, `DashboardSummaryResponse` types, `getDashboardSummary()` function
- `components/DashboardView.tsx`: Added `ThreadReplies` component (collapsible), per-channel AI summary display, "Summarize" button, summary loading state
- `styles.css`: Added styles for `.dashboard-thread-*`, `.dashboard-channel-summary-*`, `.dashboard-btn-summarize`, `.dashboard-stats`

## Key Files Changed
| What | Path |
|------|------|
| Slack message fetcher | `scripts/slack_messages.py` |
| Dashboard backend handlers | `cthulu-backend/api/dashboard/handlers.rs` |
| Dashboard routes | `cthulu-backend/api/dashboard/mod.rs` |
| API client (frontend) | `cthulu-studio/src/api/client.ts` |
| Dashboard UI | `cthulu-studio/src/components/DashboardView.tsx` |
| Styles | `cthulu-studio/src/styles.css` |

## API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/dashboard/config` | Read channel config |
| POST | `/api/dashboard/config` | Save channel config |
| GET | `/api/dashboard/messages` | Fetch messages with threads |
| POST | `/api/dashboard/summary` | Generate per-channel AI summaries |

## Status
- [x] Codebase exploration complete
- [x] Design approved (Approach A)
- [x] Python sidecar: --with-threads
- [x] Rust backend: --with-threads + /summary endpoint
- [x] Frontend: types, API, UI, CSS
- [x] Verification: `cargo check` + `npx nx build cthulu-studio` pass
