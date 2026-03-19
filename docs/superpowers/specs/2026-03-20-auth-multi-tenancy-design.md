# Auth + Multi-Tenancy Design

**Goal:** Add user authentication via Clerk and per-user data isolation so Cthulu can serve multiple users, each with their own flows, agents, sessions, and scheduled tasks.

**Architecture:** Clerk React SDK on the frontend for sign-in/sign-up, Axum JWT verification middleware on the backend using Clerk's JWKS endpoint, and filesystem-based per-user data isolation via namespaced directories.

**Tech Stack:** Clerk (React SDK + JWKS), jsonwebtoken crate (Rust JWT verification), Axum middleware extractors.

---

## 1. Frontend: Clerk React SDK Integration

### 1.1 Dependencies

Add `@clerk/clerk-react` to `cthulu-studio/package.json`.

### 1.2 Provider Setup

Wrap the app root in `<ClerkProvider>`:

```tsx
// main.tsx
import { ClerkProvider } from '@clerk/clerk-react';

const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

<ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
  <App />
</ClerkProvider>
```

### 1.3 Auth Pages

Create a simple auth gate: if the user is not signed in, show `<SignIn />`. If signed in, show the main app.

```tsx
// App.tsx (top-level)
import { SignedIn, SignedOut, SignIn } from '@clerk/clerk-react';

function App() {
  return (
    <>
      <SignedOut>
        <div className="auth-container">
          <SignIn routing="hash" />
        </div>
      </SignedOut>
      <SignedIn>
        {/* existing App content */}
      </SignedIn>
    </>
  );
}
```

No separate routes needed. `routing="hash"` avoids React Router dependency.

### 1.4 API Client Token Injection

Modify `api/client.ts` to attach the Clerk session token to every request:

```ts
// Create a getToken function that can be set from the React tree
let getTokenFn: (() => Promise<string | null>) | null = null;

export function setAuthTokenGetter(fn: () => Promise<string | null>) {
  getTokenFn = fn;
}

// Modified fetch wrapper — replaces all direct fetch() calls in client.ts
async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getTokenFn ? await getTokenFn() : null;
  const headers = new Headers(options.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(url, { ...options, headers });
}
```

A top-level `<AuthTokenProvider>` component calls `setAuthTokenGetter` with Clerk's `getToken()` on mount.

### 1.5 SSE Endpoints: Token via Query Parameter

The browser's `EventSource` API does not support custom headers. The codebase has three SSE patterns:

1. **`interactStream.ts`** — uses `fetch()` + `ReadableStream` (already supports headers).
2. **`runStream.ts`** — uses `fetch()` + `ReadableStream` (already supports headers).
3. **`client.ts` EventSource calls** — uses native `EventSource` (no header support).

**Solution:** For `fetch`-based SSE (patterns 1 and 2), use the `authFetch` wrapper. For native `EventSource` calls, append the token as a query parameter: `?token={jwt}`. The backend SSE endpoints check `Authorization` header first, then fall back to `?token` query param.

### 1.6 User Profile

Add a `<UserButton />` component from Clerk in the `TopBar` for profile management, sign-out, etc.

---

## 2. Backend: JWT Verification Middleware

### 2.1 Dependencies

Add to `Cargo.toml`:
- `jsonwebtoken` — JWT decoding and verification

No new HTTP client needed — JWKS fetching reuses the existing `AppState.http_client` (`reqwest::Client`).

### 2.2 JWKS Fetching and Caching

Create `cthulu-backend/api/clerk_auth.rs` (separate from the existing `api/auth/` module which handles Claude OAuth tokens):

- On first request (or when cache expires), fetch JWKS from `https://{CLERK_DOMAIN}/.well-known/jwks.json` using `state.http_client`
- Cache the JWKS keys in an `Arc<RwLock<JwksCache>>` inside `AppState`
- Cache TTL: 1 hour (Clerk rotates keys infrequently)
- On verification failure with `kid` not found, force-refresh the cache once

### 2.3 Middleware Extractor

Create an Axum extractor `AuthUser`:

```rust
pub struct AuthUser {
    pub user_id: String,  // Clerk user ID (e.g., "user_2abc...")
    pub email: Option<String>,
}

#[async_trait]
impl<S> FromRequestParts<S> for AuthUser
where
    S: Send + Sync,
    AppState: FromRef<S>,
{
    type Rejection = (StatusCode, Json<Value>);

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        // 1. If clerk_domain is None (local dev), return a default dev user
        // 2. Extract Bearer token from Authorization header
        //    OR from ?token query parameter (for SSE endpoints)
        // 3. Decode JWT header to get `kid`
        // 4. Look up public key from cached JWKS
        // 5. Verify signature (RS256), expiry, issuer (https://{CLERK_DOMAIN})
        // 6. Extract `sub` claim as user_id
        // 7. Validate user_id format (alphanumeric + underscore only, for path safety)
    }
}
```

### 2.4 Route Protection

**All endpoints are protected** except:
- `GET /health` — health check
- `GET /` and static file serving — Studio UI assets
- `GET /.well-known/*` — if any

Protected endpoints (non-exhaustive):
- All `/api/flows/*`, `/api/agents/*`, `/api/prompts/*`
- `/api/scheduler/*`, `/api/dashboard/*`
- `POST /claude` — Claude proxy (sensitive, must be protected)
- All SSE streaming endpoints

The `AuthUser` extractor is added as a parameter to every handler function. When `clerk_domain` is `None`, the extractor returns a hardcoded dev user (no verification).

### 2.5 Configuration

New environment variables:
- `VITE_CLERK_PUBLISHABLE_KEY` — for frontend (Clerk publishable key)
- `CLERK_SECRET_KEY` — for backend (optional, for admin API calls)
- `CLERK_DOMAIN` — e.g., `your-app.clerk.accounts.dev` (for JWKS URL)

Add to `Config` struct in `config.rs`:

```rust
pub clerk_domain: Option<String>,  // CLERK_DOMAIN env var
```

When `clerk_domain` is `None`, auth middleware is bypassed (local dev mode).

### 2.6 CORS Considerations

The current CORS config (`routes.rs:31-34`) uses `allow_origin(Any)`. For production with auth:
- `allow_origin(Any)` works with Bearer token auth (no cookies).
- If cookie-based sessions are added later, origin must be restricted.
- The `AUTHORIZATION` header is already in the allowed headers list.

No CORS changes needed for initial release. Add a note in deployment docs that production should use specific origins.

---

## 3. Data Isolation: Per-User Directories

### 3.1 Directory Structure

```
~/.cthulu/
  users/
    user_2abc.../
      flows/
      agents/
      prompts/
      sessions.yaml
      dashboard.json
      credentials.json
    user_2def.../
      flows/
      agents/
      ...
  flows/          # legacy single-user (kept for backward compat)
  agents/         # legacy single-user
  sessions.yaml   # legacy single-user
```

### 3.2 UserDataDir Abstraction

Create a helper that resolves the per-user data directory:

```rust
fn user_data_dir(state: &AppState, user_id: &str) -> PathBuf {
    state.data_dir.join("users").join(user_id)
}

/// Returns per-user repositories for flows, agents, prompts.
fn user_repos(state: &AppState, user_id: &str) -> (FileFlowRepository, FileAgentRepository, FilePromptRepository) {
    let base = user_data_dir(state, user_id);
    (
        FileFlowRepository::new(base.join("flows")),
        FileAgentRepository::new(base.join("agents")),
        FilePromptRepository::new(base.join("prompts")),
    )
}
```

### 3.3 Migration Path

- Existing single-user data at `~/.cthulu/flows/` etc. stays untouched.
- New multi-user data goes under `~/.cthulu/users/`.
- When auth is disabled (local dev, `CLERK_DOMAIN` unset), handlers use the legacy flat structure (`state.data_dir` directly) — fully backward compatible.
- On first authenticated request, the user's directory is created with empty subdirectories if it doesn't exist.
- Legacy `sessions.yaml` is NOT auto-migrated. Users start fresh when auth is enabled.

### 3.4 File Repositories Become Per-Request

The codebase uses `FileFlowRepository`, `FileAgentRepository`, `FilePromptRepository` (implementing `FlowRepository`, `AgentRepository`, `PromptRepository` traits). Currently initialized once at startup in `main.rs` and stored in `AppState`.

For multi-tenancy, repositories are constructed per-request using `user_repos()`. The repositories are stateless (just read/write files to a directory), so this has no overhead.

**Refactoring approach:** Each handler currently does `state.flow_repo.get_flow(id)`. After this change, handlers do:

```rust
async fn get_flow(auth: AuthUser, State(state): State<AppState>, Path(id): Path<String>) -> ... {
    let (flow_repo, _, _) = user_repos(&state, &auth.user_id);
    flow_repo.get_flow(&id)
}
```

---

## 4. Scheduler: User-Scoped Execution

### 4.1 Current State

The scheduler (`FlowScheduler`) starts trigger loops for all enabled flows at boot. It holds:
- `flow_repo: Arc<dyn FlowRepository>` — single global repo
- `handles: Mutex<HashMap<String, JoinHandle<()>>>` — keyed by flow ID

### 4.2 Multi-User Scheduler Refactoring

**Approach:** Create a `MultiUserFlowRepository` that wraps per-user directories:

```rust
struct MultiUserFlowRepository {
    data_dir: PathBuf,  // ~/.cthulu
}

impl MultiUserFlowRepository {
    /// List all flows across all users, returning (user_id, Flow) pairs.
    fn list_all_user_flows(&self) -> Vec<(String, Flow)> {
        let users_dir = self.data_dir.join("users");
        // iterate user dirs, load each user's flows
    }

    /// Get a specific user's flow repository.
    fn user_repo(&self, user_id: &str) -> FileFlowRepository {
        FileFlowRepository::new(self.data_dir.join("users").join(user_id).join("flows"))
    }
}
```

The scheduler key changes from `flow_id` to `{user_id}::{flow_id}`. On startup:

```rust
for (user_id, flow) in multi_repo.list_all_user_flows() {
    if flow.enabled {
        scheduler.start_flow(&user_id, &flow).await;
    }
}
```

Inside `cron_loop` and `github_pr_loop`, the scheduler re-fetches the flow using the per-user `FileFlowRepository` (constructed from the composite key's `user_id`).

### 4.3 Per-User Claude Credentials

Each user needs their own Claude API key or OAuth token. Stored in `~/.cthulu/users/{user_id}/credentials.json`:

```json
{
  "claude_oauth_token": "sk-ant-oat01-...",
  "github_token": "ghp_..."
}
```

The executor reads the user's token when spawning Claude CLI, injecting it via `env("CLAUDE_CODE_OAUTH_TOKEN", &user_token)`.

---

## 5. AppState Changes

### 5.1 New Fields

```rust
pub struct AppState {
    // === Existing fields (unchanged) ===
    pub data_dir: PathBuf,          // ~/.cthulu (root)
    pub http_client: reqwest::Client,
    pub github: Option<Arc<GithubClient>>,
    pub live_processes: Arc<Mutex<HashMap<String, LiveClaudeProcess>>>,
    pub interact_sessions: Arc<RwLock<HashMap<String, FlowSessions>>>,
    pub session_streams: Arc<Mutex<HashMap<String, broadcast::Sender<String>>>>,
    pub chat_event_buffers: Arc<Mutex<HashMap<String, Vec<String>>>>,
    pub sdk_sessions: Arc<Mutex<HashMap<String, AgentSession>>>,
    pub pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    pub scheduler: Arc<FlowScheduler>,
    pub sandbox_provider: Arc<dyn SandboxProvider>,
    pub changes_tx: broadcast::Sender<ResourceChange>,
    pub global_hook_tx: broadcast::Sender<HookEvent>,
    pub oauth_token: Option<String>,  // kept for dev mode / legacy

    // === New fields ===
    pub clerk_domain: Option<String>,
    pub jwks_cache: Arc<RwLock<JwksCache>>,

    // === Removed from AppState (now per-request) ===
    // flow_repo: Arc<dyn FlowRepository>,      -- removed
    // agent_repo: Arc<dyn AgentRepository>,     -- removed
    // prompt_repo: Arc<dyn PromptRepository>,   -- removed
}
```

### 5.2 In-Memory State Keying Changes

All in-memory state maps use composite keys with `user_id` prefix:

| Map | Current Key | New Key |
|-----|-------------|---------|
| `live_processes` | `agent::{agent_id}::session::{session_id}` | `{user_id}::agent::{agent_id}::session::{session_id}` |
| `interact_sessions` | `agent::{agent_id}` | `{user_id}::agent::{agent_id}` |
| `session_streams` | `{process_key}` | `{user_id}::{process_key}` |
| `chat_event_buffers` | `{process_key}` | `{user_id}::{process_key}` |
| `sdk_sessions` | `{process_key}` | `{user_id}::{process_key}` |
| `pending_permissions` | `{process_key}` | `{user_id}::{process_key}` |
| `scheduler.handles` | `{flow_id}` | `{user_id}::{flow_id}` |

Helper function to construct composite keys:

```rust
fn user_key(user_id: &str, key: &str) -> String {
    format!("{user_id}::{key}")
}
```

### 5.3 Session Persistence

`sessions.yaml` becomes per-user at `~/.cthulu/users/{user_id}/sessions.yaml`. The `load_sessions` and `save_sessions` functions take a `data_dir` parameter instead of reading from `AppState.data_dir` directly.

---

## 6. Security Considerations

- **JWT verification**: Full RS256 signature verification using JWKS. Not just decoding.
- **Directory traversal**: Validate `user_id` matches `^[a-zA-Z0-9_]+$` before constructing paths.
- **Cross-user isolation**: The `AuthUser` extractor ensures handlers only access the authenticated user's data.
- **Local dev bypass**: When `CLERK_DOMAIN` is unset, all endpoints work without auth (backward compatible). A hardcoded dev user ID is used.
- **Credentials at rest**: User Claude tokens stored in plain text initially. Encryption is a follow-up.
- **Token in query params**: SSE endpoints accept `?token=` — these tokens are short-lived (Clerk JWTs expire in ~60s by default). Log scrubbing should exclude query params.
- **Concurrent process cap**: Each user is limited to `MAX_CONCURRENT_CLAUDE_PROCESSES = 5` simultaneous Claude CLI processes (enforced via a per-user semaphore in the process pool).

---

## 7. Error Handling

- **401 Unauthorized**: Missing or invalid Bearer token / query token.
- **403 Forbidden**: Valid token but attempting to access another user's resources (shouldn't happen with per-user dirs, but guard anyway).
- **503 Service Unavailable**: JWKS endpoint unreachable (cache serves stale keys as fallback).
- **429 Too Many Requests**: User exceeded concurrent process limit.

---

## 8. Testing Strategy

### Backend
- Unit tests for JWT verification with mock JWKS (valid token, expired token, wrong issuer, invalid signature)
- Unit tests for directory isolation (user A can't see user B's flows)
- Unit tests for composite key construction and parsing
- Integration test: protected endpoint returns 401 without token
- Integration test: SSE endpoint accepts `?token=` query parameter

### Frontend
- Test that `<SignedOut>` shows sign-in page
- Test that API client attaches Bearer token to fetch calls
- Test that SSE connections append token as query param
- Test that `<SignedIn>` renders the app

---

## 9. Out of Scope (Follow-ups)

- Billing / usage metering
- Admin dashboard (manage all users)
- Credential encryption at rest
- Database migration (PostgreSQL)
- Rate limiting per user (beyond concurrent process cap)
- User quota management (max flows, max agents)
- Legacy data migration tool (move `~/.cthulu/flows/` into a user directory)
