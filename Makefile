## Cthulu project Makefile
##
## Common targets:
##   make build              Build both binaries (release)
##   make build-backend      Build the cthulu backend binary (release)
##   make build-mcp          Build the cthulu-mcp binary (release)
##   make clean              Remove all build artifacts (cargo clean)
##   make clean-build        Clean + rebuild both binaries (release)
##   make check              Run cargo check on all targets
##   make run-backend        Run the backend locally (cargo run)
##   make run-mcp            Run cthulu-mcp locally (cargo run)
##   make setup-mcp          Register cthulu-mcp in Claude Desktop config
##   make searxng-start      Start SearXNG via Docker Compose
##   make searxng-stop       Stop SearXNG
##   make searxng-status     Check SearXNG health
##   make help               Show this help

# ---------------------------------------------------------------------------
# Configurable variables (override on command line or in environment)
# ---------------------------------------------------------------------------

# Launcher script — auto-starts the backend then execs cthulu-mcp.
# Claude Desktop runs this instead of the binary directly.
MCP_LAUNCHER ?= $(shell pwd)/scripts/mcp-launcher.sh

# Absolute path to the binaries
BACKEND_BINARY ?= $(shell pwd)/target/release/cthulu
MCP_BINARY     ?= $(shell pwd)/target/release/cthulu-mcp

# Cthulu backend URL
CTHULU_URL ?= http://localhost:8081

# SearXNG URL (set to "disabled" to force DDG fallback)
# Use 127.0.0.1 (not localhost) to avoid reqwest resolving to IPv6 ::1 first
SEARXNG_URL ?= http://127.0.0.1:8888

# Claude Desktop config file location (macOS default)
CLAUDE_CONFIG_DIR := $(HOME)/Library/Application Support/Claude
CLAUDE_CONFIG     := $(CLAUDE_CONFIG_DIR)/claude_desktop_config.json

# ---------------------------------------------------------------------------
# Phony targets
# ---------------------------------------------------------------------------
.PHONY: help build build-backend build-mcp clean clean-build check \
       run-backend run-mcp setup-mcp searxng-start searxng-stop searxng-status

# ---------------------------------------------------------------------------
# help
# ---------------------------------------------------------------------------
help:
	@echo ""
	@echo "Usage: make <target> [VAR=value ...]"
	@echo ""
	@echo "Build targets:"
	@echo "  build              Build both binaries (release)"
	@echo "  build-backend      Build cthulu backend release binary"
	@echo "  build-mcp          Build cthulu-mcp release binary"
	@echo "  clean              Remove all build artifacts (cargo clean)"
	@echo "  clean-build        Clean + rebuild both binaries (release)"
	@echo "  check              Run cargo check on all targets"
	@echo ""
	@echo "Run targets:"
	@echo "  run-backend        Run backend locally on :8081 (dev profile)"
	@echo "  run-mcp            Run cthulu-mcp locally (dev profile, stdio)"
	@echo ""
	@echo "MCP targets:"
	@echo "  setup-mcp          Register cthulu-mcp in Claude Desktop config"
	@echo ""
	@echo "SearXNG targets:"
	@echo "  searxng-start      Start SearXNG Docker container"
	@echo "  searxng-stop       Stop SearXNG Docker container"
	@echo "  searxng-status     Print SearXNG health"
	@echo ""
	@echo "Variables (current values):"
	@echo "  BACKEND_BINARY = $(BACKEND_BINARY)"
	@echo "  MCP_BINARY     = $(MCP_BINARY)"
	@echo "  CTHULU_URL     = $(CTHULU_URL)"
	@echo "  SEARXNG_URL    = $(SEARXNG_URL)"
	@echo ""

# ---------------------------------------------------------------------------
# build — build both release binaries
# ---------------------------------------------------------------------------
build: build-backend build-mcp

# ---------------------------------------------------------------------------
# build-backend — build the backend release binary
# ---------------------------------------------------------------------------
build-backend:
	cargo build --release --bin cthulu
	@echo ""
	@echo "Binary: $(BACKEND_BINARY)"

# ---------------------------------------------------------------------------
# build-mcp — build the MCP release binary
# ---------------------------------------------------------------------------
build-mcp:
	cargo build --release --bin cthulu-mcp
	@echo ""
	@echo "Binary: $(MCP_BINARY)"

# ---------------------------------------------------------------------------
# clean — remove all build artifacts
# ---------------------------------------------------------------------------
clean:
	cargo clean
	@echo ""
	@echo "Build artifacts removed."

# ---------------------------------------------------------------------------
# clean-build — clean + rebuild both binaries
# ---------------------------------------------------------------------------
clean-build: clean build

# ---------------------------------------------------------------------------
# check — cargo check all targets
# ---------------------------------------------------------------------------
check:
	cargo check --bin cthulu --bin cthulu-mcp
	@echo ""
	@echo "All targets compile."

# ---------------------------------------------------------------------------
# run-backend — run the backend locally (dev profile)
# ---------------------------------------------------------------------------
run-backend:
	cargo run --bin cthulu -- serve

# ---------------------------------------------------------------------------
# run-mcp — run cthulu-mcp locally (dev profile)
# ---------------------------------------------------------------------------
run-mcp:
	cargo run --bin cthulu-mcp -- --base-url $(CTHULU_URL) --searxng-url $(SEARXNG_URL)

# ---------------------------------------------------------------------------
# setup-mcp — write (or merge) Claude Desktop config
#
# Logic:
#   1. Create config dir if it doesn't exist.
#   2. If no config file exists, write a fresh one.
#   3. If a config file exists, use Python (bundled on macOS) to merge the
#      "cthulu" entry into the existing mcpServers object so we don't
#      clobber other registered servers.
# ---------------------------------------------------------------------------
setup-mcp:
	@echo ""
	@echo "==> Registering cthulu-mcp in Claude Desktop"
	@echo "    Launcher: $(MCP_LAUNCHER)"
	@echo "    Binary  : $(MCP_BINARY)"
	@echo "    Backend : $(CTHULU_URL)"
	@echo "    SearXNG : $(SEARXNG_URL)"
	@echo ""
	@if [ ! -f "$(MCP_BINARY)" ]; then \
		echo "ERROR: Binary not found at $(MCP_BINARY)"; \
		echo "       Run 'make build-mcp' first, or set MCP_BINARY=<path>"; \
		exit 1; \
	fi
	@chmod +x "$(MCP_LAUNCHER)"
	@mkdir -p "$(CLAUDE_CONFIG_DIR)"
	@python3 scripts/setup_mcp_config.py \
		"$(CLAUDE_CONFIG)" \
		"$(MCP_LAUNCHER)" \
		"$(CTHULU_URL)" \
		"$(SEARXNG_URL)"
	@echo ""
	@echo "Done. Restart Claude Desktop to load the new server."
	@echo "Tip: You can verify with: cat \"$(CLAUDE_CONFIG)\""
	@echo ""

# ---------------------------------------------------------------------------
# searxng-start — start SearXNG in the background
# ---------------------------------------------------------------------------
searxng-start:
	docker compose -f docker-compose.searxng.yml up -d
	@echo ""
	@echo "SearXNG starting on http://localhost:8888"
	@echo "Test: curl -s 'http://localhost:8888/search?q=hello&format=json' | python3 -m json.tool | head -20"
	@echo ""

# ---------------------------------------------------------------------------
# searxng-stop
# ---------------------------------------------------------------------------
searxng-stop:
	docker compose -f docker-compose.searxng.yml down

# ---------------------------------------------------------------------------
# searxng-status
# ---------------------------------------------------------------------------
searxng-status:
	@docker ps --filter "name=cthulu-searxng" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "Docker not available"
	@echo ""
	@curl -sf 'http://localhost:8888/search?q=test&format=json' > /dev/null \
		&& echo "Health: OK (JSON endpoint responding)" \
		|| echo "Health: NOT responding (container may still be starting)"
