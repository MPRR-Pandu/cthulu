# 🛠️ Makefile Guide

> Everything you need to build, run, and manage Cthulu from the command line.

---

## 🚀 Quick Start

```bash
# Fresh clean build of everything
make clean-build

# Or just check it compiles first
make check
```

---

## 📦 Build Targets

| Command | What it does |
|---------|-------------|
| `make build` | 🏗️ Build both `cthulu` + `cthulu-mcp` release binaries |
| `make build-backend` | 🖥️ Build just the backend (`target/release/cthulu`) |
| `make build-mcp` | 🤖 Build just the MCP server (`target/release/cthulu-mcp`) |
| `make clean` | 🧹 Wipe all build artifacts (`cargo clean`) |
| `make clean-build` | ♻️ Clean + rebuild both binaries from scratch |
| `make check` | ✅ Run `cargo check` on both binaries (fast compile check) |

---

## 🏃 Run Targets

| Command | What it does |
|---------|-------------|
| `make run-backend` | 🖥️ Start the backend on `:8081` (dev profile) |
| `make run-mcp` | 🤖 Start `cthulu-mcp` over stdio (dev profile) |

> 💡 **Tip:** Run these in separate terminals — backend first, then MCP.

```bash
# Terminal 1
make run-backend

# Terminal 2
make run-mcp
```

---

## 🔌 MCP Setup

| Command | What it does |
|---------|-------------|
| `make setup-mcp` | 📝 Register `cthulu-mcp` in Claude Desktop config |

This writes to `~/Library/Application Support/Claude/claude_desktop_config.json` and merges safely with any existing MCP servers you have configured.

> ⚠️ **Requires:** Run `make build-mcp` first so the binary exists.

---

## 🔍 SearXNG (Web Search)

| Command | What it does |
|---------|-------------|
| `make searxng-start` | 🐳 Start SearXNG Docker container on `:8888` |
| `make searxng-stop` | 🛑 Stop the SearXNG container |
| `make searxng-status` | 💚 Check SearXNG health |

SearXNG gives `cthulu-mcp` unlimited web search. Without it, search falls back to DuckDuckGo HTML scraping (rate-limited to 30 req/min).

---

## ⚙️ Configuration

Override any variable on the command line:

```bash
make run-mcp CTHULU_URL=http://localhost:9090 SEARXNG_URL=disabled
```

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKEND_BINARY` | `./target/release/cthulu` | Path to backend binary |
| `MCP_BINARY` | `./target/release/cthulu-mcp` | Path to MCP binary |
| `CTHULU_URL` | `http://localhost:8081` | Backend API URL |
| `SEARXNG_URL` | `http://127.0.0.1:8888` | SearXNG URL (`"disabled"` to skip) |

> 📌 We use `127.0.0.1` instead of `localhost` for SearXNG to avoid IPv6 resolution issues with `reqwest`.

---

## 🗂️ Common Workflows

### 🆕 First time setup
```bash
make clean-build        # Build everything fresh
make searxng-start      # Start web search (optional)
make setup-mcp          # Register with Claude Desktop
```

### 🔄 Daily development
```bash
make check              # Quick compile check after changes
make run-backend        # Start backend in terminal 1
make run-mcp            # Start MCP in terminal 2
```

### 🚢 Release build
```bash
make clean-build        # Full clean rebuild
make setup-mcp          # Update Claude Desktop registration
```

---

## 📝 Notes

- 🍎 **macOS filesystem:** There was previously a duplicate `makefile` (lowercase) — on macOS's case-insensitive filesystem both names pointed to the same file. Only `Makefile` (uppercase) exists now.
- 🏎️ **Dev vs Release:** `make run-*` targets use the dev profile (faster compile, slower runtime). `make build*` targets produce optimized release binaries.
- 📡 **Port 8081:** Make sure nothing else is using `:8081` before running the backend. Kill squatters with `lsof -ti:8081 | xargs kill`.
