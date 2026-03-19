# Cthulu Cloud — A2A Remote Agent Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Python service that provides A2A-compliant remote agents with inter-agent communication, automated code review, and per-user Anthropic API key isolation.

**Architecture:** Single Python process (FastAPI + FastMCP + a2a-sdk) deployed to EKS. Agents are data in MongoDB, executed via Anthropic Claude API. Cthulu MCP Server provides all tools including `ask_agent` for inter-agent delegation. SQS FIFO for async task queuing.

**Tech Stack:** Python 3.12, FastAPI, FastMCP, a2a-sdk, anthropic, motor (MongoDB), boto3 (SQS), PyJWT, httpx, pytest

**Spec:** `docs/superpowers/specs/2026-03-15-cthulu-cloud-a2a-design.md`

**Project root:** `/Users/mundlapatipandurangaraju/Desktop/zanoWallets/dev/_newclone/cthulu-cloud/`

---

## Chunk 1: Project Bootstrap + Config + Database

### Task 1: Initialize Python Project

**Files:**
- Create: `cthulu-cloud/pyproject.toml`
- Create: `cthulu-cloud/src/__init__.py`
- Create: `cthulu-cloud/src/config.py`
- Create: `cthulu-cloud/docker-compose.yml`
- Create: `cthulu-cloud/.env.example`
- Create: `cthulu-cloud/.gitignore`

- [ ] **Step 1: Create project directory and pyproject.toml**

```toml
[project]
name = "cthulu-cloud"
version = "0.1.0"
description = "A2A Remote Agent Orchestrator for Cthulu Studio"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.34.0",
    "anthropic>=0.52.0",
    "motor>=3.7.0",
    "pymongo>=4.10.0",
    "boto3>=1.36.0",
    "PyJWT>=2.10.0",
    "httpx>=0.28.0",
    "fastmcp>=2.11.0",
    "a2a-sdk>=0.3.0",
    "pydantic>=2.10.0",
    "python-dotenv>=1.1.0",
    "cryptography>=44.0.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.25.0",
    "mongomock-motor>=0.0.34",
    "ruff>=0.9.0",
]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]

[tool.ruff]
target-version = "py312"
line-length = 100
```

- [ ] **Step 2: Create config.py**

```python
# src/config.py
import os
from dataclasses import dataclass, field
from dotenv import load_dotenv

load_dotenv()

@dataclass(frozen=True)
class Config:
    mongodb_uri: str = field(default_factory=lambda: os.getenv("MONGODB_URI", "mongodb://localhost:27017/cthulu_cloud"))
    db_name: str = field(default_factory=lambda: os.getenv("DB_NAME", "cthulu_cloud"))
    port: int = field(default_factory=lambda: int(os.getenv("PORT", "8080")))
    jwt_secret: str = field(default_factory=lambda: os.getenv("JWT_SECRET", "dev-secret-change-me"))
    jwt_algorithm: str = "HS256"
    jwt_expiry_hours: int = 24
    sqs_queue_url: str = field(default_factory=lambda: os.getenv("SQS_QUEUE_URL", ""))
    aws_region: str = field(default_factory=lambda: os.getenv("AWS_REGION", "us-east-1"))
    log_level: str = field(default_factory=lambda: os.getenv("LOG_LEVEL", "info"))
    encryption_key: str = field(default_factory=lambda: os.getenv("ENCRYPTION_KEY", "dev-encryption-key-32bytes!!!!!"))

config = Config()
```

- [ ] **Step 3: Create docker-compose.yml for local dev**

```yaml
version: "3.9"
services:
  mongodb:
    image: mongo:7
    ports:
      - "27017:27017"
    volumes:
      - mongo-data:/data/db
  app:
    build: .
    ports:
      - "8080:8080"
    env_file: .env
    depends_on:
      - mongodb
volumes:
  mongo-data:
```

- [ ] **Step 4: Create .env.example and .gitignore**

- [ ] **Step 5: Install dependencies**

Run: `cd cthulu-cloud && uv sync`

### Task 2: MongoDB Client + Collections

**Files:**
- Create: `cthulu-cloud/src/db/__init__.py`
- Create: `cthulu-cloud/src/db/mongo.py`
- Create: `cthulu-cloud/tests/__init__.py`
- Create: `cthulu-cloud/tests/unit/__init__.py`
- Create: `cthulu-cloud/tests/unit/test_db.py`

- [ ] **Step 1: Write test for MongoDB client initialization**

```python
# tests/unit/test_db.py
import pytest
from src.db.mongo import MongoClient, get_db

@pytest.fixture
async def db():
    client = MongoClient("mongodb://localhost:27017/cthulu_cloud_test")
    await client.connect()
    yield client
    await client.drop_database()
    await client.close()

async def test_connect_and_list_collections(db):
    collections = await db.list_collection_names()
    assert isinstance(collections, list)

async def test_users_collection_exists(db):
    await db.users.insert_one({"username": "test"})
    doc = await db.users.find_one({"username": "test"})
    assert doc["username"] == "test"
```

- [ ] **Step 2: Implement MongoDB client**

```python
# src/db/mongo.py
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from src.config import config

class MongoClient:
    def __init__(self, uri: str | None = None):
        self._uri = uri or config.mongodb_uri
        self._client: AsyncIOMotorClient | None = None
        self._db: AsyncIOMotorDatabase | None = None

    async def connect(self):
        self._client = AsyncIOMotorClient(self._uri)
        db_name = self._uri.rsplit("/", 1)[-1].split("?")[0]
        self._db = self._client[db_name]
        # Create indexes
        await self._db.users.create_index("github_username", unique=True)
        await self._db.agents.create_index([("org", 1), ("name", 1)], unique=True)
        await self._db.tasks.create_index("task_id", unique=True)
        await self._db.tasks.create_index([("org", 1), ("agent_id", 1), ("state", 1)])

    @property
    def users(self):
        return self._db["users"]

    @property
    def agents(self):
        return self._db["agents"]

    @property
    def tasks(self):
        return self._db["tasks"]

    @property
    def reviews(self):
        return self._db["reviews"]

    async def list_collection_names(self):
        return await self._db.list_collection_names()

    async def drop_database(self):
        if self._client and self._db:
            await self._client.drop_database(self._db.name)

    async def close(self):
        if self._client:
            self._client.close()

_client: MongoClient | None = None

async def get_db() -> MongoClient:
    global _client
    if _client is None:
        _client = MongoClient()
        await _client.connect()
    return _client
```

- [ ] **Step 3: Run tests**

Run: `cd cthulu-cloud && uv run pytest tests/unit/test_db.py -v`
Expected: PASS (requires local MongoDB running via `docker compose up mongodb`)

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(cthulu-cloud): bootstrap project with config and MongoDB client"
```

---

## Chunk 2: Auth (GitHub PAT + JWT)

### Task 3: GitHub PAT Validation

**Files:**
- Create: `cthulu-cloud/src/auth/__init__.py`
- Create: `cthulu-cloud/src/auth/github.py`
- Create: `cthulu-cloud/src/auth/jwt.py`
- Create: `cthulu-cloud/src/auth/middleware.py`
- Create: `cthulu-cloud/src/auth/encryption.py`
- Create: `cthulu-cloud/tests/unit/test_auth.py`

- [ ] **Step 1: Write tests for JWT issuance and validation**

```python
# tests/unit/test_auth.py
import pytest
from src.auth.jwt import create_token, decode_token

def test_create_and_decode_token():
    token = create_token(username="pandu", org="MPRR-Pandu")
    payload = decode_token(token)
    assert payload["sub"] == "pandu"
    assert payload["org"] == "MPRR-Pandu"

def test_invalid_token_raises():
    with pytest.raises(Exception):
        decode_token("invalid.token.here")

def test_encryption_roundtrip():
    from src.auth.encryption import encrypt_value, decrypt_value
    original = "sk-ant-api03-test-key"
    encrypted = encrypt_value(original)
    assert encrypted != original
    decrypted = decrypt_value(encrypted)
    assert decrypted == original
```

- [ ] **Step 2: Implement JWT module**

```python
# src/auth/jwt.py
import datetime
import jwt
from src.config import config

def create_token(username: str, org: str) -> str:
    payload = {
        "sub": username,
        "org": org,
        "iat": datetime.datetime.now(datetime.UTC),
        "exp": datetime.datetime.now(datetime.UTC) + datetime.timedelta(hours=config.jwt_expiry_hours),
    }
    return jwt.encode(payload, config.jwt_secret, algorithm=config.jwt_algorithm)

def decode_token(token: str) -> dict:
    return jwt.decode(token, config.jwt_secret, algorithms=[config.jwt_algorithm])
```

- [ ] **Step 3: Implement GitHub PAT validation**

```python
# src/auth/github.py
import httpx

async def validate_pat(pat: str) -> dict:
    """Validate a GitHub PAT and return user info + orgs."""
    async with httpx.AsyncClient() as client:
        # Get user info
        resp = await client.get(
            "https://api.github.com/user",
            headers={"Authorization": f"Bearer {pat}", "Accept": "application/vnd.github.v3+json"},
        )
        resp.raise_for_status()
        user = resp.json()

        # Get user's orgs
        resp_orgs = await client.get(
            "https://api.github.com/user/orgs",
            headers={"Authorization": f"Bearer {pat}", "Accept": "application/vnd.github.v3+json"},
        )
        resp_orgs.raise_for_status()
        orgs = [o["login"] for o in resp_orgs.json()]

    return {
        "username": user["login"],
        "name": user.get("name", ""),
        "avatar_url": user.get("avatar_url", ""),
        "orgs": orgs,
    }
```

- [ ] **Step 4: Implement encryption helpers**

```python
# src/auth/encryption.py
import base64
from cryptography.fernet import Fernet
from src.config import config

def _get_fernet() -> Fernet:
    key = base64.urlsafe_b64encode(config.encryption_key.encode()[:32].ljust(32, b"0"))
    return Fernet(key)

def encrypt_value(value: str) -> str:
    return _get_fernet().encrypt(value.encode()).decode()

def decrypt_value(encrypted: str) -> str:
    return _get_fernet().decrypt(encrypted.encode()).decode()
```

- [ ] **Step 5: Implement auth middleware**

```python
# src/auth/middleware.py
from fastapi import Request, HTTPException
from src.auth.jwt import decode_token

async def get_current_user(request: Request) -> dict:
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    token = auth_header.removeprefix("Bearer ")
    try:
        return decode_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
```

- [ ] **Step 6: Run tests and commit**

Run: `cd cthulu-cloud && uv run pytest tests/unit/test_auth.py -v`

```bash
git add -A && git commit -m "feat(cthulu-cloud): GitHub PAT validation, JWT auth, API key encryption"
```

---

## Chunk 3: Agent Registry + Types

### Task 4: Agent Types and Registry

**Files:**
- Create: `cthulu-cloud/src/agents/__init__.py`
- Create: `cthulu-cloud/src/agents/types.py`
- Create: `cthulu-cloud/src/agents/registry.py`
- Create: `cthulu-cloud/tests/unit/test_agents.py`

- [ ] **Step 1: Write tests for agent types and CRUD**

```python
# tests/unit/test_agents.py
import pytest
from src.agents.types import AgentDefinition, SubAgentDef, AgentSkill

def test_agent_definition_creation():
    agent = AgentDefinition(
        org="MPRR-Pandu",
        name="code-reviewer",
        system_prompt="You are a code reviewer...",
        skills=[AgentSkill(name="Code Review", description="Reviews PRs")],
        model="claude-sonnet-4-20250514",
    )
    assert agent.name == "code-reviewer"
    assert len(agent.skills) == 1

def test_sub_agent_def():
    sub = SubAgentDef(
        description="Finds bugs",
        prompt="You are a bug finder...",
        tools=["Read", "Grep"],
        model="claude-sonnet-4-20250514",
        max_turns=10,
    )
    assert sub.max_turns == 10

def test_agent_with_sub_agents():
    ceo = AgentDefinition(
        org="MPRR-Pandu",
        name="ceo",
        system_prompt="You are the CEO...",
        sub_agents={
            "researcher": SubAgentDef(
                description="Research agent",
                prompt="You research...",
                tools=["web_search"],
            ),
        },
    )
    assert "researcher" in ceo.sub_agents
```

- [ ] **Step 2: Implement agent types**

```python
# src/agents/types.py
from pydantic import BaseModel, Field
from datetime import datetime, UTC

class AgentSkill(BaseModel):
    name: str
    description: str
    tags: list[str] = []
    examples: list[str] = []

class SubAgentDef(BaseModel):
    description: str
    prompt: str
    tools: list[str] = []
    model: str = "claude-sonnet-4-20250514"
    max_turns: int = 10

class AgentDefinition(BaseModel):
    org: str
    name: str
    system_prompt: str
    description: str = ""
    skills: list[AgentSkill] = []
    sub_agents: dict[str, SubAgentDef] = {}
    model: str = "claude-sonnet-4-20250514"
    role: str = "agent"  # "leader" or "agent"
    reports_to: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
```

- [ ] **Step 3: Implement agent registry (MongoDB CRUD)**

```python
# src/agents/registry.py
from src.db.mongo import MongoClient
from src.agents.types import AgentDefinition
from datetime import datetime, UTC

class AgentRegistry:
    def __init__(self, db: MongoClient):
        self._db = db

    async def create(self, agent: AgentDefinition) -> AgentDefinition:
        doc = agent.model_dump()
        await self._db.agents.insert_one(doc)
        return agent

    async def get(self, org: str, name: str) -> AgentDefinition | None:
        doc = await self._db.agents.find_one({"org": org, "name": name})
        if doc:
            doc.pop("_id", None)
            return AgentDefinition(**doc)
        return None

    async def list_by_org(self, org: str) -> list[AgentDefinition]:
        cursor = self._db.agents.find({"org": org})
        agents = []
        async for doc in cursor:
            doc.pop("_id", None)
            agents.append(AgentDefinition(**doc))
        return agents

    async def update(self, org: str, name: str, updates: dict) -> AgentDefinition | None:
        updates["updated_at"] = datetime.now(UTC)
        result = await self._db.agents.update_one(
            {"org": org, "name": name},
            {"$set": updates},
        )
        if result.modified_count:
            return await self.get(org, name)
        return None

    async def delete(self, org: str, name: str) -> bool:
        result = await self._db.agents.delete_one({"org": org, "name": name})
        return result.deleted_count > 0

    async def sync_from_desktop(self, org: str, agent_data: dict) -> AgentDefinition:
        """Upsert an agent definition synced from the desktop app."""
        agent_data["org"] = org
        agent_data["updated_at"] = datetime.now(UTC)
        await self._db.agents.update_one(
            {"org": org, "name": agent_data["name"]},
            {"$set": agent_data},
            upsert=True,
        )
        return await self.get(org, agent_data["name"])
```

- [ ] **Step 4: Run tests and commit**

Run: `cd cthulu-cloud && uv run pytest tests/unit/test_agents.py -v`

```bash
git add -A && git commit -m "feat(cthulu-cloud): agent types, registry with MongoDB CRUD"
```

---

## Chunk 4: A2A Protocol Server + Agent Cards

### Task 5: A2A Types and Agent Cards

**Files:**
- Create: `cthulu-cloud/src/a2a/__init__.py`
- Create: `cthulu-cloud/src/a2a/types.py`
- Create: `cthulu-cloud/src/a2a/cards.py`
- Create: `cthulu-cloud/src/a2a/handler.py`
- Create: `cthulu-cloud/tests/unit/test_a2a.py`

- [ ] **Step 1: Write tests for A2A types and Agent Card generation**

Tests verify: Task state machine, Agent Card generation from AgentDefinition, JSON-RPC request parsing.

- [ ] **Step 2: Implement A2A types** (Task, Message, Part, Artifact, TaskState)

- [ ] **Step 3: Implement Agent Card generation** from AgentDefinition

- [ ] **Step 4: Implement JSON-RPC 2.0 handler** (message/send, tasks/get, tasks/list, tasks/cancel)

- [ ] **Step 5: Run tests and commit**

---

## Chunk 5: Cthulu MCP Server

### Task 6: MCP Server with All Tools

**Files:**
- Create: `cthulu-cloud/src/mcp_server/__init__.py`
- Create: `cthulu-cloud/src/mcp_server/server.py`
- Create: `cthulu-cloud/src/mcp_server/agent_tools.py`
- Create: `cthulu-cloud/src/mcp_server/github_tools.py`
- Create: `cthulu-cloud/src/mcp_server/external_tools.py`
- Create: `cthulu-cloud/src/mcp_server/system_tools.py`
- Create: `cthulu-cloud/tests/unit/test_mcp_tools.py`

- [ ] **Step 1: Write tests for MCP tools** (ask_agent, list_agents, github_get_pr_diff)

- [ ] **Step 2: Implement MCP server** (FastMCP with all tool categories)

- [ ] **Step 3: Implement agent_tools.py** (ask_agent, list_agents, get_agent_skills)

- [ ] **Step 4: Implement github_tools.py** (get_pr_diff, get_file, post_review, post_comment)

- [ ] **Step 5: Implement external_tools.py** (get_exchange_rate, web_search, slack_send)

- [ ] **Step 6: Implement system_tools.py** (get_user_context, get_org_info, get_system_capabilities)

- [ ] **Step 7: Run tests and commit**

---

## Chunk 6: Agent Executor (Claude API)

### Task 7: Claude API Executor

**Files:**
- Create: `cthulu-cloud/src/executor/__init__.py`
- Create: `cthulu-cloud/src/executor/claude.py`
- Create: `cthulu-cloud/src/executor/tools.py`
- Create: `cthulu-cloud/tests/unit/test_executor.py`

- [ ] **Step 1: Write tests for executor** (mock Claude API, tool calling loop)

- [ ] **Step 2: Implement Claude executor** (Messages API with tool use loop)

- [ ] **Step 3: Implement tool dispatcher** (MCP tool call → result)

- [ ] **Step 4: Run tests and commit**

---

## Chunk 7: Code Review Agent

### Task 8: Code Review Engine + Prompts

**Files:**
- Create: `cthulu-cloud/src/review/__init__.py`
- Create: `cthulu-cloud/src/review/engine.py`
- Create: `cthulu-cloud/src/review/scorecard.py`
- Create: `cthulu-cloud/src/review/webhook.py`
- Create: `cthulu-cloud/src/agents/prompts/code_reviewer.md`
- Create: `cthulu-cloud/src/agents/prompts/bugs_bunny.md`
- Create: `cthulu-cloud/src/agents/prompts/ceo.md`
- Create: `cthulu-cloud/src/agents/prompts/researcher.md`
- Create: `cthulu-cloud/tests/unit/test_review.py`
- Create: `cthulu-cloud/tests/integration/test_code_review.py`

- [ ] **Step 1: Write tests for scorecard** (re-review tracking)

- [ ] **Step 2: Port code_reviewer_prompt.md** from cthulu-backend

- [ ] **Step 3: Implement review engine** (orchestrates review flow)

- [ ] **Step 4: Implement scorecard** (tracks previous findings, diffs for re-review)

- [ ] **Step 5: Implement webhook handler** (GitHub PR events → trigger review)

- [ ] **Step 6: Run tests and commit**

---

## Chunk 8: SQS Worker + Queue

### Task 9: SQS FIFO Queue Integration

**Files:**
- Create: `cthulu-cloud/src/queue/__init__.py`
- Create: `cthulu-cloud/src/queue/sqs_worker.py`
- Create: `cthulu-cloud/tests/unit/test_queue.py`

- [ ] **Step 1: Write tests for queue** (enqueue, dequeue, message group isolation)

- [ ] **Step 2: Implement SQS producer** (enqueue task with MessageGroupId)

- [ ] **Step 3: Implement SQS worker** (poll, dispatch to executor, update MongoDB)

- [ ] **Step 4: Run tests and commit**

---

## Chunk 9: FastAPI App + Routes

### Task 10: HTTP Server Assembly

**Files:**
- Create: `cthulu-cloud/src/main.py`
- Create: `cthulu-cloud/src/api/__init__.py`
- Create: `cthulu-cloud/src/api/routes.py`
- Create: `cthulu-cloud/tests/integration/test_api.py`

- [ ] **Step 1: Write integration tests** (login, agent CRUD, A2A message/send)

- [ ] **Step 2: Implement FastAPI app** (compose all routes)

- [ ] **Step 3: Implement REST management routes** (auth, agent CRUD, sync, queue status)

- [ ] **Step 4: Implement A2A routes** (Agent Card serving, JSON-RPC endpoint)

- [ ] **Step 5: Run integration tests and commit**

---

## Chunk 10: Deployment + E2E Tests

### Task 11: Docker + K8s + E2E

**Files:**
- Create: `cthulu-cloud/Dockerfile`
- Create: `cthulu-cloud/k8s/deployment.yaml`
- Create: `cthulu-cloud/k8s/service.yaml`
- Create: `cthulu-cloud/k8s/ingress.yaml`
- Create: `cthulu-cloud/tests/e2e/test_full_flow.py`

- [ ] **Step 1: Create Dockerfile**

- [ ] **Step 2: Create K8s manifests**

- [ ] **Step 3: Write E2E tests** (login → create agent → send message → get result)

- [ ] **Step 4: Run full test suite**

Run: `cd cthulu-cloud && uv run pytest -v`

- [ ] **Step 5: Final commit**

```bash
git add -A && git commit -m "feat(cthulu-cloud): complete A2A remote agent orchestrator"
```
