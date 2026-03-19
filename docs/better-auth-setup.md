# Better Auth Setup for Cthulu

Better Auth runs as a **separate Node.js service** that handles signup, login, sessions, and social OAuth. Cthulu's Rust backend verifies the session tokens. The Studio frontend talks to Better Auth for auth flows and to Cthulu for everything else.

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌────────────────────┐
│  Cthulu Studio  │────▶│  Better Auth Server   │     │  Cthulu Backend    │
│  (React UI)     │     │  (Node.js, port 3000) │     │  (Rust, port 8081) │
│  port 5173      │────▶│                       │     │                    │
│                 │     │  /api/auth/sign-up     │     │  /api/flows        │
│                 │     │  /api/auth/sign-in     │     │  /api/agents       │
│                 │     │  /api/auth/session     │     │  /api/prompts      │
│                 │────▶│                       │────▶│                    │
└─────────────────┘     └──────────────────────┘     └────────────────────┘
        │                        │                           │
        │  Auth requests ───────▶│                           │
        │  API requests ────────────────────────────────────▶│
        │                        │  JWT cookie ─────────────▶│ (verify)
```

## Option 1: Docker (Recommended)

### 1. Create the Better Auth project

```bash
mkdir cthulu-auth && cd cthulu-auth
npm init -y
npm install better-auth better-sqlite3 @hono/node-server hono
```

### 2. Create `auth.ts`

```ts
import { betterAuth } from "better-auth";
import Database from "better-sqlite3";

export const auth = betterAuth({
  database: new Database("./auth.db"),
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET,

  emailAndPassword: {
    enabled: true,
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 min cache
      strategy: "jwt", // Cthulu Rust backend can verify this
    },
  },

  trustedOrigins: [
    "http://localhost:5173", // Cthulu Studio dev
    "http://localhost:8081", // Cthulu Backend dev
  ],
});
```

### 3. Create `server.ts`

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { auth } from "./auth";

const app = new Hono();

app.use("*", cors({
  origin: ["http://localhost:5173", "http://localhost:8081"],
  credentials: true,
}));

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.get("/health", (c) => c.json({ status: "ok" }));

const port = parseInt(process.env.PORT || "3000");
serve({ fetch: app.fetch, port }, () => {
  console.log(`Better Auth running on http://localhost:${port}`);
});
```

### 4. Create `.env`

```bash
# Generate with: openssl rand -base64 32
BETTER_AUTH_SECRET=your-secret-here-at-least-32-chars-long
BETTER_AUTH_URL=http://localhost:3000
PORT=3000
```

### 5. Run database migration

```bash
npx auth@latest migrate
```

### 6. Create `Dockerfile`

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN npx auth@latest migrate
EXPOSE 3000
CMD ["npx", "tsx", "server.ts"]
```

### 7. Create `docker-compose.yml`

```yaml
services:
  auth:
    build: .
    ports:
      - "3000:3000"
    environment:
      - BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
      - BETTER_AUTH_URL=http://localhost:3000
      - PORT=3000
    volumes:
      - auth-data:/app  # persist SQLite DB

volumes:
  auth-data:
```

### 8. Run

```bash
docker compose up -d
# Verify:
curl http://localhost:3000/health
```

---

## Option 2: Run Locally (Development)

```bash
cd cthulu-auth
npm install tsx --save-dev
echo 'BETTER_AUTH_SECRET=dev-secret-at-least-32-characters-long!' > .env
npx auth@latest migrate
npx tsx server.ts
```

---

## Connecting Cthulu Studio to Better Auth

### Frontend: Install Better Auth client

In `cthulu-studio/`:

```bash
npm install better-auth
```

### Frontend: Create auth client

Create `cthulu-studio/src/api/auth-client.ts`:

```ts
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: "http://localhost:3000", // Better Auth server
});

export const { signIn, signUp, signOut, useSession } = authClient;
```

### Frontend: Update AuthGate component

Update `cthulu-studio/src/components/AuthGate.tsx` to use Better Auth:

```tsx
import { useSession } from "../api/auth-client";

export default function AuthGate({ children }) {
  const { data: session, isPending } = useSession();

  if (isPending) return <div className="auth-container">Loading...</div>;
  if (!session) return <AuthForm />;
  return <>{children}</>;
}
```

### Backend: Verify Better Auth session tokens

Better Auth with `cookieCache.strategy: "jwt"` sends a JWT in the
`better-auth.session_data` cookie. Cthulu's Rust backend reads this
cookie and verifies the JWT signature using the same `BETTER_AUTH_SECRET`.

The existing `clerk_auth.rs` `AuthUser` extractor needs one change:
instead of reading `Authorization: Bearer` header, read the
`better-auth.session_data` cookie and verify with HS256.

Set in Cthulu's `.env`:
```bash
BETTER_AUTH_SECRET=same-secret-as-auth-server
AUTH_ENABLED=true
```

---

## Environment Variables Summary

| Variable | Where | Value |
|----------|-------|-------|
| `BETTER_AUTH_SECRET` | Auth server + Cthulu backend | Same 32+ char secret |
| `BETTER_AUTH_URL` | Auth server | `http://localhost:3000` |
| `AUTH_ENABLED` | Cthulu backend | `true` |
| `VITE_AUTH_ENABLED` | Cthulu Studio | `true` |
| `VITE_AUTH_URL` | Cthulu Studio | `http://localhost:3000` |

---

## Adding Social Login (Optional)

```ts
// In auth.ts, add:
socialProviders: {
  github: {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  },
},
```

---

## Production Deployment

1. Deploy Better Auth to any Node.js host (Railway, Fly.io, VPS, Docker)
2. Use PostgreSQL instead of SQLite for production:
   ```ts
   import { Pool } from "pg";
   database: new Pool({ connectionString: process.env.DATABASE_URL })
   ```
3. Update `trustedOrigins` and `BETTER_AUTH_URL` to production domains
4. Set `BETTER_AUTH_SECRET` to a cryptographically random value
5. Enable HTTPS on both services
