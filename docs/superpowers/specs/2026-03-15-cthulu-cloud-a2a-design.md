# Cthulu Cloud — A2A Remote Agent Orchestrator

## Overview

A standalone Python service deployed on EKS that provides A2A (Agent-to-Agent) protocol-compliant remote agents for Cthulu Studio users. Each user brings their own Anthropic API key, authenticates via GitHub PAT, and gets per-org agent hierarchies (leader + sub-agents) that communicate via A2A protocol. A central Cthulu MCP server provides all tools (including inter-agent communication via `ask_agent`). An automated code review agent replicates the Bugs Bunny review intelligence from PR #110.

## Architecture

**Option C Hybrid**: Single Python deployment using Google ADK (open source, Apache 2.0) for A2A server compliance + Anthropic Claude as the LLM backend. Agents are data in MongoDB (not separate processes). The Cthulu MCP Server (FastMCP) runs in-process and provides all tools to all agents.

**No Google Cloud dependency.** ADK is a pip library — it runs anywhere. Claude is the LLM. AWS SQS for async queuing. MongoDB for persistence.

## System Diagram

```
Desktop App (Tauri/Rust)
    │
    │ HTTPS + GitHub PAT
    ▼
┌──────────────────────────────────────────────────────┐
│  cthulu-cloud (Python, single EKS pod)               │
│                                                      │
│  ┌─ REST API Layer ──────────────────────────────┐   │
│  │  POST /api/auth/login     (GitHub PAT → JWT)  │   │
│  │  CRUD /api/agents         (MongoDB)           │   │
│  │  POST /api/agents/sync    (from desktop app)  │   │
│  │  GET  /api/queue/status   (SQS stats)         │   │
│  └───────────────────────────────────────────────┘   │
│                                                      │
│  ┌─ A2A Server Layer ────────────────────────────┐   │
│  │  GET  /{org}/{agent}/.well-known/agent.json   │   │
│  │  POST /{org}/{agent}  (JSON-RPC 2.0)          │   │
│  │    • message/send, message/stream             │   │
│  │    • tasks/get, tasks/list, tasks/cancel      │   │
│  └───────────────────────────────────────────────┘   │
│                                                      │
│  ┌─ Agent Hierarchy (per-org, from MongoDB) ─────┐   │
│  │  CEO (leader) ──┬── code-reviewer             │   │
│  │                 ├── bugs-bunny                 │   │
│  │                 ├── researcher                 │   │
│  │                 └── currency-agent             │   │
│  │  All agents: tools=[MCPToolset(CTHULU_MCP)]   │   │
│  └───────────────────────────────────────────────┘   │
│              │                                       │
│              │ MCP protocol (in-process)              │
│              ▼                                       │
│  ┌─ Cthulu MCP Server (FastMCP) ─────────────────┐   │
│  │  ask_agent(target, message) → inter-agent      │   │
│  │  list_agents() → agent discovery               │   │
│  │  github_get_pr_diff(repo, pr) → PR review      │   │
│  │  github_post_review(repo, pr, ...) → post      │   │
│  │  get_exchange_rate(from, to) → currency        │   │
│  │  web_search(query) → web research              │   │
│  │  slack_send(channel, msg) → notifications      │   │
│  └───────────────────────────────────────────────┘   │
│                                                      │
│  ┌─ Infrastructure ─────────────────────────────┐   │
│  │  MongoDB  → agents, tasks, users, reviews     │   │
│  │  SQS FIFO → async task queue (per-user order) │   │
│  │  Auth     → GitHub PAT validation → JWT       │   │
│  └───────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Agents Are Data, Not Processes

Each agent is a document in MongoDB with a system prompt, skills, and tools. When a request arrives, the service loads the definition, makes a Claude API call with that agent's prompt, and returns the result. No separate containers, no VMs, no sidecars.

### 2. Per-User Anthropic API Keys

Each user provides their own Anthropic API key (stored encrypted in MongoDB). All Claude API calls for that user's agents use their key. The service has zero LLM cost.

### 3. Prompt Isolation = Agent Isolation

Each Claude API call is stateless with its own system prompt, tools, and messages. Agent A cannot see Agent B's context. This is stronger than process isolation.

### 4. Cthulu MCP Server as Central Tool Hub

Instead of each agent connecting to separate MCP servers, all agents connect to ONE Cthulu MCP Server that provides everything — including `ask_agent()` for inter-agent communication.

### 5. Agent Cards for A2A Discovery

Every agent gets an A2A Agent Card at `/{org}/{agent}/.well-known/agent.json` describing its capabilities, skills, and authentication requirements.

### 6. SQS FIFO with Per-User Ordering

One shared SQS FIFO queue: `cthulu-tasks.fifo`. `MessageGroupId = "{org}::{username}"` ensures per-user ordering. Supports ~5-50 users per queue.

### 7. Automated Code Review Agent

The code-reviewer agent uses the same `code_reviewer_prompt.md` from the desktop app. Produces severity-tagged reviews (🔴/🟡/🟣), inline comments, re-review scorecards, and posts directly to GitHub PRs.

### 8. Agent Sync from Desktop App

Agent definitions from the Agents tab in Cthulu Studio can be synced to the cloud service. Same prompts, same hierarchy — just running remotely via A2A instead of locally via Claude CLI.

## MongoDB Collections

| Collection | Key Fields | Purpose |
|-----------|-----------|---------|
| `users` | github_username, org, anthropic_api_key_enc, pat_hash | User registry |
| `agents` | org, name, system_prompt, skills[], mcp_tools[], sub_agents{}, model | Agent definitions |
| `tasks` | task_id, context_id, org, agent_id, state, messages[], artifacts[] | A2A task lifecycle |
| `reviews` | org, repo, pr_number, review_id, findings[], scorecard[] | Code review history (for re-reviews) |

## API Endpoints

### REST (Management)
- `POST /api/auth/login` — GitHub PAT → JWT
- `CRUD /api/agents` — Agent definitions
- `POST /api/agents/sync` — Sync from desktop app
- `GET /api/queue/status` — SQS stats

### A2A (JSON-RPC 2.0)
- `GET /{org}/{agent}/.well-known/agent.json` — Agent Card
- `POST /{org}/{agent}` — message/send, tasks/get, tasks/list, tasks/cancel

## Project Structure

```
cthulu-cloud/
├── pyproject.toml
├── Dockerfile
├── docker-compose.yml
├── k8s/
│   ├── deployment.yaml
│   ├── service.yaml
│   └── ingress.yaml
├── src/
│   ├── main.py
│   ├── config.py
│   ├── auth/
│   │   ├── github.py
│   │   └── jwt.py
│   ├── agents/
│   │   ├── registry.py
│   │   ├── builder.py
│   │   ├── types.py
│   │   └── prompts/
│   │       ├── ceo.md
│   │       ├── code_reviewer.md
│   │       ├── bugs_bunny.md
│   │       └── researcher.md
│   ├── a2a/
│   │   ├── server.py
│   │   └── cards.py
│   ├── mcp_server/
│   │   ├── server.py
│   │   ├── agent_tools.py
│   │   ├── github_tools.py
│   │   ├── external_tools.py
│   │   └── system_tools.py
│   ├── review/
│   │   ├── engine.py
│   │   ├── scorecard.py
│   │   └── webhook.py
│   ├── queue/
│   │   └── sqs_worker.py
│   └── db/
│       └── mongo.py
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

## Tech Stack

| Technology | Purpose |
|-----------|---------|
| Python 3.12+ | Runtime |
| FastAPI/Uvicorn | HTTP server |
| FastMCP | MCP server |
| a2a-sdk | A2A protocol types/client |
| anthropic | Claude API client |
| motor (async MongoDB) | Database driver |
| boto3 | AWS SQS |
| PyJWT | JWT tokens |
| httpx | HTTP client (GitHub API, external tools) |
| pytest + pytest-asyncio | Testing |

## Environment Variables

```bash
MONGODB_URI=mongodb://localhost:27017/cthulu_cloud
AWS_REGION=us-east-1
SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/.../cthulu-tasks.fifo
JWT_SECRET=your-secret
PORT=8080
LOG_LEVEL=info
```
