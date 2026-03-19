# Auth + Multi-Tenancy Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Clerk-based authentication and per-user data isolation to Cthulu so it can serve multiple users with independent flows, agents, and scheduled tasks.

**Architecture:** Clerk React SDK on frontend (sign-in gate + token injection), Axum JWT middleware on backend (JWKS verification), per-user filesystem directories for data isolation, user-scoped in-memory state keys.

**Tech Stack:** Clerk React SDK, jsonwebtoken crate, Axum extractors, existing reqwest client for JWKS fetch.

**Spec:** `docs/superpowers/specs/2026-03-20-auth-multi-tenancy-design.md`

---

## File Structure

### New files to create
| File | Responsibility |
|------|---------------|
| `cthulu-backend/api/clerk_auth.rs` | JWKS cache, JWT verification, `AuthUser` extractor |
| `cthulu-backend/api/user_context.rs` | `user_data_dir()`, `user_repos()`, `user_key()` helpers |
| `cthulu-studio/src/components/AuthGate.tsx` | `<SignedIn>`/`<SignedOut>` wrapper + token provider |

### Files to modify
| File | Change |
|------|--------|
| `Cargo.toml` | Add `jsonwebtoken` dependency |
| `cthulu-studio/package.json` | Add `@clerk/clerk-react` |
| `cthulu-backend/config.rs` | Add `clerk_domain: Option<String>` |
| `cthulu-backend/api/mod.rs` | Add `jwks_cache`, `clerk_domain` to `AppState`; add `pub mod clerk_auth; pub mod user_context;` |
| `cthulu-backend/api/routes.rs` | No changes (auth is per-handler via extractor, not middleware layer) |
| `cthulu-backend/main.rs` | Construct JWKS cache, set `clerk_domain` in AppState |
| `cthulu-studio/src/main.tsx` | Wrap in `<ClerkProvider>` |
| `cthulu-studio/src/App.tsx` | Wrap content in `<AuthGate>` |
| `cthulu-studio/src/api/client.ts` | Add `authFetch` wrapper, `setAuthTokenGetter` |
| `cthulu-backend/api/flows/handlers.rs` | Add `AuthUser` param, use `user_repos()` (9 sites) |
| `cthulu-backend/api/agents/handlers.rs` | Add `AuthUser` param, use `user_repos()` (6 sites) |
| `cthulu-backend/api/agents/chat.rs` | Add `AuthUser` param, use `user_key()` (3 sites) |
| `cthulu-backend/api/prompts/handlers.rs` | Add `AuthUser` param, use `user_repos()` (6 sites) |
| `cthulu-backend/api/templates/handlers.rs` | Add `AuthUser` param, use `user_repos()` (5 sites) |
| `cthulu-backend/api/scheduler/handlers.rs` | Add `AuthUser` param, use `user_repos()` (2 sites) |
| `cthulu-backend/api/dashboard/handlers.rs` | Add `AuthUser` param, use `user_data_dir()` |

---

## Chunk 1: Backend Auth Foundation

### Task 1: Add `jsonwebtoken` dependency

**Files:**
- Modify: `Cargo.toml:17-51`

- [ ] **Step 1: Add jsonwebtoken to Cargo.toml**

Add after the `serde_json` line:
```toml
jsonwebtoken = "9"
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check`
Expected: compiles with warnings

- [ ] **Step 3: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "chore: add jsonwebtoken dependency for Clerk JWT verification"
```

---

### Task 2: Add `clerk_domain` to Config

**Files:**
- Modify: `cthulu-backend/config.rs:4-17`

- [ ] **Step 1: Add `clerk_domain` field to Config struct**

```rust
pub struct Config {
    pub port: u16,
    pub sentry_dsn: Option<String>,
    pub environment: String,
    pub clerk_domain: Option<String>,
}
```

- [ ] **Step 2: Read from env in `from_env`**

Add to `from_env()`:
```rust
pub fn from_env() -> Self {
    Self::from_raw_values(
        std::env::var("PORT").ok(),
        std::env::var("SENTRY_DSN").ok(),
        std::env::var("ENVIRONMENT").ok(),
        std::env::var("CLERK_DOMAIN").ok(),
    )
}
```

Update `from_raw_values` to accept the new param and store it.

- [ ] **Step 3: Verify it compiles**

Run: `cargo check`

- [ ] **Step 4: Commit**

```bash
git add cthulu-backend/config.rs
git commit -m "feat: add CLERK_DOMAIN config for Clerk JWT auth"
```

---

### Task 3: Create `clerk_auth.rs` — JWKS cache + AuthUser extractor

**Files:**
- Create: `cthulu-backend/api/clerk_auth.rs`
- Modify: `cthulu-backend/api/mod.rs` (add `pub mod clerk_auth;`, add fields to AppState)

- [ ] **Step 1: Create `clerk_auth.rs` with JwksCache and AuthUser**

The file should contain:
- `JwksCache` struct: holds `keys: HashMap<String, DecodingKey>`, `fetched_at: Instant`
- `fetch_jwks(http_client, clerk_domain) -> Result<JwksCache>` async function
- `AuthUser` struct with `user_id: String`
- `FromRequestParts` impl for `AuthUser`:
  - If `clerk_domain` is None → return dev user `AuthUser { user_id: "dev_user".into() }`
  - Extract `Authorization: Bearer {token}` header, OR `?token={token}` query param
  - Decode JWT header → get `kid`
  - Look up key in JWKS cache (force refresh once on miss)
  - Verify with `jsonwebtoken::decode` using RS256
  - Extract `sub` claim as `user_id`
  - Validate `user_id` matches `^[a-zA-Z0-9_]+$`

- [ ] **Step 2: Add `pub mod clerk_auth;` to `api/mod.rs`**

Add after the existing module declarations.

- [ ] **Step 3: Add new fields to AppState in `api/mod.rs:289-335`**

Add:
```rust
pub clerk_domain: Option<String>,
pub jwks_cache: Arc<tokio::sync::RwLock<Option<clerk_auth::JwksCache>>>,
```

- [ ] **Step 4: Initialize in `main.rs:350-372`**

Add to AppState construction:
```rust
clerk_domain: config.clerk_domain.clone(),
jwks_cache: Arc::new(tokio::sync::RwLock::new(None)),
```

- [ ] **Step 5: Write tests for AuthUser**

Add `#[cfg(test)] mod tests` in `clerk_auth.rs`:
- `test_dev_user_when_no_clerk_domain` — extractor returns "dev_user"
- `test_rejects_missing_token` — returns 401
- `test_validates_user_id_format` — rejects IDs with `../` or special chars

- [ ] **Step 6: Run tests**

Run: `cargo test clerk_auth`
Expected: all pass

- [ ] **Step 7: Run cargo check**

Run: `cargo check`

- [ ] **Step 8: Commit**

```bash
git add cthulu-backend/api/clerk_auth.rs cthulu-backend/api/mod.rs cthulu-backend/main.rs
git commit -m "feat: add Clerk JWT verification middleware with JWKS caching"
```

---

### Task 4: Create `user_context.rs` — per-user directory + key helpers

**Files:**
- Create: `cthulu-backend/api/user_context.rs`
- Modify: `cthulu-backend/api/mod.rs` (add `pub mod user_context;`)

- [ ] **Step 1: Create `user_context.rs`**

```rust
use std::path::PathBuf;
use crate::api::AppState;
use crate::flows::file_store::FileFlowRepository;
use crate::agents::FileAgentRepository;
use crate::api::clerk_auth::AuthUser;

/// Returns the per-user data directory.
/// When auth is disabled (dev mode), returns the global data_dir.
pub fn user_data_dir(state: &AppState, auth: &AuthUser) -> PathBuf {
    if state.clerk_domain.is_some() {
        state.data_dir.join("users").join(&auth.user_id)
    } else {
        state.data_dir.clone()
    }
}

/// Prefix an in-memory key with user_id for multi-tenant isolation.
/// When auth is disabled, returns the key unchanged.
pub fn user_key(state: &AppState, auth: &AuthUser, key: &str) -> String {
    if state.clerk_domain.is_some() {
        format!("{}::{}", auth.user_id, key)
    } else {
        key.to_string()
    }
}

/// Ensure the user's data directory and subdirectories exist.
pub fn ensure_user_dirs(state: &AppState, auth: &AuthUser) -> std::io::Result<()> {
    let base = user_data_dir(state, auth);
    for sub in &["flows", "agents", "prompts"] {
        std::fs::create_dir_all(base.join(sub))?;
    }
    Ok(())
}
```

- [ ] **Step 2: Add `pub mod user_context;` to `api/mod.rs`**

- [ ] **Step 3: Write tests**

- `test_user_data_dir_with_auth` — returns `data_dir/users/{user_id}`
- `test_user_data_dir_dev_mode` — returns `data_dir` when `clerk_domain` is None
- `test_user_key_with_auth` — prefixes key
- `test_user_key_dev_mode` — returns key unchanged
- `test_ensure_user_dirs` — creates directories in temp dir

- [ ] **Step 4: Run tests**

Run: `cargo test user_context`

- [ ] **Step 5: Commit**

```bash
git add cthulu-backend/api/user_context.rs cthulu-backend/api/mod.rs
git commit -m "feat: add per-user directory and key helpers for multi-tenancy"
```

---

## Chunk 2: Backend Handler Refactoring

### Task 5: Refactor flow handlers to use AuthUser + user_repos

**Files:**
- Modify: `cthulu-backend/api/flows/handlers.rs` (9 call sites)

- [ ] **Step 1: Add AuthUser parameter to each handler**

For each handler function (list_flows, get_flow, create_flow, update_flow, delete_flow, trigger_flow, get_runs), add `auth: AuthUser` as first parameter.

- [ ] **Step 2: Replace `state.flow_repo` with per-user repo**

At the top of each handler, construct the per-user repo:
```rust
let user_dir = user_context::user_data_dir(&state, &auth);
let flow_repo = Arc::new(FileFlowRepository::new(user_dir.clone()));
```
Replace `state.flow_repo.xxx()` with `flow_repo.xxx()`.

- [ ] **Step 3: Verify it compiles**

Run: `cargo check`

- [ ] **Step 4: Commit**

```bash
git add cthulu-backend/api/flows/handlers.rs
git commit -m "feat: add AuthUser to flow handlers, use per-user repos"
```

---

### Task 6: Refactor agent handlers

**Files:**
- Modify: `cthulu-backend/api/agents/handlers.rs` (6 sites)

Same pattern as Task 5: add `AuthUser`, construct per-user `FileAgentRepository`.

- [ ] **Step 1: Add AuthUser and per-user agent repo**
- [ ] **Step 2: Verify: `cargo check`**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat: add AuthUser to agent handlers, use per-user repos"
```

---

### Task 7: Refactor prompt handlers

**Files:**
- Modify: `cthulu-backend/api/prompts/handlers.rs` (6 sites)

- [ ] **Step 1: Add AuthUser and per-user prompt repo**
- [ ] **Step 2: Verify: `cargo check`**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat: add AuthUser to prompt handlers, use per-user repos"
```

---

### Task 8: Refactor template handlers

**Files:**
- Modify: `cthulu-backend/api/templates/handlers.rs` (5 sites)

- [ ] **Step 1: Add AuthUser, construct per-user flow_repo for TemplateRepository**
- [ ] **Step 2: Verify: `cargo check`**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat: add AuthUser to template handlers, use per-user repos"
```

---

### Task 9: Refactor scheduler and dashboard handlers

**Files:**
- Modify: `cthulu-backend/api/scheduler/handlers.rs` (2 sites)
- Modify: `cthulu-backend/api/dashboard/handlers.rs`

- [ ] **Step 1: Add AuthUser to scheduler handlers**
- [ ] **Step 2: Add AuthUser to dashboard handlers, use user_data_dir for config path**
- [ ] **Step 3: Verify: `cargo check`**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat: add AuthUser to scheduler and dashboard handlers"
```

---

### Task 10: Refactor agent chat.rs key construction

**Files:**
- Modify: `cthulu-backend/api/agents/chat.rs` (key functions at lines 61-69)

- [ ] **Step 1: Update `agent_key` and `process_key` to accept user_id**

Change from:
```rust
fn agent_key(agent_id: &str) -> String { format!("agent::{agent_id}") }
fn process_key(agent_id: &str, session_id: &str) -> String { ... }
```
To:
```rust
fn agent_key(user_id: &str, agent_id: &str) -> String { format!("{user_id}::agent::{agent_id}") }
fn process_key(user_id: &str, agent_id: &str, session_id: &str) -> String { ... }
```

- [ ] **Step 2: Update all callers of agent_key/process_key to pass AuthUser.user_id**

The chat handlers that use these functions need `AuthUser` added as a parameter.

- [ ] **Step 3: Verify: `cargo check`**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat: add user_id to session key construction for multi-tenant isolation"
```

---

### Task 11: Remove global repos from AppState

**Files:**
- Modify: `cthulu-backend/api/mod.rs:289-335` (AppState struct)
- Modify: `cthulu-backend/main.rs:350-372` (AppState construction)

- [ ] **Step 1: Remove `flow_repo`, `agent_repo`, `prompt_repo` from AppState**

Remove lines 293-295 from AppState struct. Remove corresponding lines from main.rs construction.

- [ ] **Step 2: Keep repo construction in main.rs for seeding Studio Assistant**

The Studio Assistant seeding (main.rs:151-172) still needs a global agent repo. Create it locally just for seeding, not stored in AppState.

- [ ] **Step 3: Verify: `cargo check`**

This should surface any remaining `state.flow_repo` / `state.agent_repo` / `state.prompt_repo` usages that weren't refactored. Fix them.

- [ ] **Step 4: Run `cargo test`**

Run: `cargo test`
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: remove global repos from AppState, all access is now per-user"
```

---

## Chunk 3: Frontend Auth Integration

### Task 12: Add Clerk React SDK

**Files:**
- Modify: `cthulu-studio/package.json`

- [ ] **Step 1: Install @clerk/clerk-react**

Run: `npm install @clerk/clerk-react` (from cthulu-studio/)

- [ ] **Step 2: Verify build**

Run: `npx nx build cthulu-studio`

- [ ] **Step 3: Commit**

```bash
git add cthulu-studio/package.json cthulu-studio/../../package-lock.json
git commit -m "chore: add @clerk/clerk-react dependency"
```

---

### Task 13: Add ClerkProvider and AuthGate

**Files:**
- Create: `cthulu-studio/src/components/AuthGate.tsx`
- Modify: `cthulu-studio/src/main.tsx`
- Modify: `cthulu-studio/src/App.tsx`

- [ ] **Step 1: Create AuthGate.tsx**

```tsx
import { SignedIn, SignedOut, SignIn, useAuth } from "@clerk/clerk-react";
import { useEffect } from "react";
import { setAuthTokenGetter } from "../api/client";

function AuthTokenProvider({ children }: { children: React.ReactNode }) {
  const { getToken } = useAuth();
  useEffect(() => {
    setAuthTokenGetter(() => getToken());
    return () => setAuthTokenGetter(null);
  }, [getToken]);
  return <>{children}</>;
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  // If no Clerk key configured, skip auth (dev mode)
  if (!clerkKey) return <>{children}</>;

  return (
    <>
      <SignedOut>
        <div className="auth-container">
          <SignIn routing="hash" />
        </div>
      </SignedOut>
      <SignedIn>
        <AuthTokenProvider>{children}</AuthTokenProvider>
      </SignedIn>
    </>
  );
}
```

- [ ] **Step 2: Wrap App in ClerkProvider in main.tsx**

```tsx
import { ClerkProvider } from "@clerk/clerk-react";

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      {CLERK_KEY ? (
        <ClerkProvider publishableKey={CLERK_KEY}>
          <App />
        </ClerkProvider>
      ) : (
        <App />
      )}
    </ThemeProvider>
  </React.StrictMode>
);
```

- [ ] **Step 3: Wrap App content in AuthGate in App.tsx**

Inside `App()` return, wrap the entire content:
```tsx
return (
  <AuthGate>
    <div className="app">
      {/* existing content */}
    </div>
  </AuthGate>
);
```

- [ ] **Step 4: Verify build**

Run: `npx nx build cthulu-studio`

- [ ] **Step 5: Commit**

```bash
git add cthulu-studio/src/components/AuthGate.tsx cthulu-studio/src/main.tsx cthulu-studio/src/App.tsx
git commit -m "feat: add Clerk auth gate with dev mode bypass"
```

---

### Task 14: Add authFetch to API client

**Files:**
- Modify: `cthulu-studio/src/api/client.ts`

- [ ] **Step 1: Add token getter and authFetch wrapper**

At the top of client.ts (after imports):
```ts
let getTokenFn: (() => Promise<string | null>) | null = null;

export function setAuthTokenGetter(fn: (() => Promise<string | null>) | null) {
  getTokenFn = fn;
}
```

- [ ] **Step 2: Modify `apiFetch` to attach Bearer token**

In the existing `apiFetch` function (lines 40-77), before the `fetch()` call, add:
```ts
if (getTokenFn) {
  const token = await getTokenFn();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
}
```

- [ ] **Step 3: Modify EventSource SSE calls to append ?token**

For `streamSessionLog` (line 329) and `subscribeToChanges` (line 589), modify the URL construction to append the token as query param:
```ts
const token = getTokenFn ? await getTokenFn() : null;
const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
const url = `${getBaseUrl()}/api/...${tokenParam}`;
```

- [ ] **Step 4: Verify build**

Run: `npx nx build cthulu-studio`

- [ ] **Step 5: Commit**

```bash
git add cthulu-studio/src/api/client.ts
git commit -m "feat: add auth token injection to API client and SSE endpoints"
```

---

## Chunk 4: Integration + Verification

### Task 15: Add UserButton to TopBar

**Files:**
- Modify: `cthulu-studio/src/components/TopBar.tsx`

- [ ] **Step 1: Add UserButton from Clerk**

Import `UserButton` from `@clerk/clerk-react`. Add it to the right side of the TopBar, conditionally rendered when `VITE_CLERK_PUBLISHABLE_KEY` is set.

- [ ] **Step 2: Verify build**

Run: `npx nx build cthulu-studio`

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: add Clerk UserButton to TopBar for profile management"
```

---

### Task 16: Add auth-container CSS

**Files:**
- Modify: `cthulu-studio/src/styles.css`

- [ ] **Step 1: Add minimal auth styles**

```css
.auth-container {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background: var(--bg);
}
```

- [ ] **Step 2: Commit**

```bash
git commit -m "style: add auth container centered layout"
```

---

### Task 17: Full integration verification

- [ ] **Step 1: Run cargo check**

Run: `cargo check`
Expected: 0 errors

- [ ] **Step 2: Run all Rust tests**

Run: `cargo test`
Expected: all pass

- [ ] **Step 3: Run frontend build**

Run: `npx nx build cthulu-studio`
Expected: builds clean

- [ ] **Step 4: Run frontend tests**

Run: `npx vitest run` (from cthulu-studio/)
Expected: all pass

- [ ] **Step 5: Manual smoke test (dev mode, no Clerk key)**

Start the server: `cargo run -- serve`
Open Studio: http://localhost:5173
Expected: app loads normally without any auth gate (dev mode bypass)

- [ ] **Step 6: Commit and create feature branch**

```bash
git checkout -b feat/auth-multi-tenancy
git add -A
git commit -m "feat: complete auth + multi-tenancy foundation

- Clerk JWT verification via JWKS (with caching and dev mode bypass)
- Per-user filesystem directories for data isolation
- AuthUser extractor on all API handlers
- Clerk React SDK with SignIn/SignOut gate
- Auth token injection on all API and SSE requests
- UserButton in TopBar for profile management"
```
