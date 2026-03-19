# Org/Project/Agent Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Paperclip-inspired Org > Project > Agent hierarchy to Cthulu Studio, stored in the `cthulu-agents` GitHub repo with the structure `<OrgName>/projects/<project-name>/<agent-id>/`.

**Architecture:** Orgs are top-level folders in the single `cthulu-agents` GitHub repo. Projects are subfolders under `<org>/projects/`. Agents are published into project folders as `agent.json` + `prompt.md`. The frontend gets a Paperclip-style OrgRail (narrow icon strip) + redesigned Sidebar scoped to the selected org, with collapsible Projects section showing agents nested inside.

**Tech Stack:** Rust/Tauri (backend commands), React/TypeScript (frontend), GitHub Contents API (storage), CSS variables (theming)

---

## Repo Structure

```
cthulu-agents/                    (private GitHub repo)
  <OrgName>/
    org.json                      (name, description, created_at)
    projects/
      <project-name>/
        project.json              (name, description, color, status)
        <agent-id>/
          agent.json              (agent definition minus prompt/project)
          prompt.md               (agent prompt text)
      <project-name-2>/
        ...
  <AnotherOrg>/
    org.json
    projects/
      ...
```

## File Map

### Backend (Tauri commands)
| File | Action | Purpose |
|------|--------|---------|
| `src-tauri/src/commands/agent_repo.rs` | Modify | Add org CRUD (create_org, list_orgs, delete_org), update project/publish/sync to use `<org>/projects/` path |
| `src-tauri/src/main.rs` | Modify | Register new Tauri commands |

### Frontend (new files)
| File | Purpose |
|------|---------|
| `src/contexts/OrgContext.tsx` | Selected org state, org list, CRUD functions |
| `src/components/OrgRail.tsx` | Narrow vertical org switcher (Paperclip CompanyRail style) |
| `src/components/SidebarProjects.tsx` | Collapsible project list with nested agents |
| `src/components/NewOrgDialog.tsx` | Dialog to create a new org |
| `src/components/NewProjectDialog.tsx` | Dialog to create a new project within an org |

### Frontend (modified files)
| File | Changes |
|------|---------|
| `src/api/client.ts` | Add org CRUD API functions, update project/publish functions with org param |
| `src/components/Sidebar.tsx` | Restructure to show Projects section with nested agents |
| `src/App.tsx` | Add OrgContext provider, OrgRail to layout |
| `src/styles.css` | Add OrgRail, SidebarProjects, NewOrgDialog styles |
| `src/types/flow.ts` | Add Org, Project interfaces |

---

## Chunk 1: Backend — Org Support in agent_repo.rs

### Task 1: Add Org Types and CRUD Commands

**Files:**
- Modify: `src-tauri/src/commands/agent_repo.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add `list_orgs` command**

In `agent_repo.rs`, add after the `sync_dir()` helper:

```rust
// ---------------------------------------------------------------------------
// Org management
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_orgs(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;
    let sync = sync_dir(&state);

    if !sync.exists() {
        return Ok(json!({ "orgs": [] }));
    }

    let mut orgs = Vec::new();
    let entries = std::fs::read_dir(&sync)
        .map_err(|e| format!("Failed to read sync directory: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "projects" {
                continue;
            }
            // Read org.json if it exists
            let org_json_path = path.join("org.json");
            let org_meta: serde_json::Value = if org_json_path.exists() {
                let content = std::fs::read_to_string(&org_json_path).unwrap_or_default();
                serde_json::from_str(&content).unwrap_or_else(|_| json!({ "name": name }))
            } else {
                json!({ "name": name })
            };

            orgs.push(json!({
                "slug": name,
                "name": org_meta["name"].as_str().unwrap_or(&name),
                "description": org_meta["description"].as_str().unwrap_or(""),
            }));
        }
    }

    orgs.sort_by(|a, b| {
        let an = a["name"].as_str().unwrap_or("");
        let bn = b["name"].as_str().unwrap_or("");
        an.cmp(bn)
    });

    Ok(json!({ "orgs": orgs }))
}
```

- [ ] **Step 2: Add `create_org` command**

```rust
#[tauri::command]
pub async fn create_org(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    name: String,
    description: Option<String>,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;
    let pat = require_pat(&state).await?;
    let owner = read_owner(&state).ok_or_else(|| {
        "Agent repo not set up. Call setup_agent_repo first.".to_string()
    })?;

    // Slug: lowercase, alphanumeric + hyphens
    let slug = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();
    let slug = slug.trim_matches('-').to_string();

    if slug.is_empty() {
        return Err("Org name cannot be empty".to_string());
    }

    let org_dir = sync_dir(&state).join(&slug);
    if org_dir.exists() {
        return Err(format!("Org '{}' already exists", slug));
    }

    // Create local directory structure
    std::fs::create_dir_all(org_dir.join("projects"))
        .map_err(|e| format!("Failed to create org directory: {e}"))?;

    // Write org.json locally
    let org_meta = json!({
        "name": name.trim(),
        "description": description.unwrap_or_default(),
        "created_at": chrono::Utc::now().to_rfc3339(),
    });
    let org_json_str = serde_json::to_string_pretty(&org_meta).unwrap_or_default();
    std::fs::write(org_dir.join("org.json"), &org_json_str)
        .map_err(|e| format!("Failed to write org.json: {e}"))?;

    // Push org.json to GitHub
    let encoded = base64::engine::general_purpose::STANDARD.encode(org_json_str.as_bytes());
    let put_url = format!(
        "https://api.github.com/repos/{}/{}/contents/{}/org.json",
        owner, REPO_NAME, slug
    );

    let resp = state
        .http_client
        .put(&put_url)
        .header("Authorization", format!("Bearer {}", pat))
        .header("User-Agent", "cthulu-studio")
        .header("Accept", "application/vnd.github+json")
        .json(&json!({
            "message": format!("Create org: {}", name.trim()),
            "content": encoded,
        }))
        .send()
        .await
        .map_err(|e| format!("GitHub PUT error: {e}"))?;

    if !resp.status().is_success() && resp.status() != reqwest::StatusCode::UNPROCESSABLE_ENTITY {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("GitHub PUT error: {body}"));
    }

    // Also push a .gitkeep in projects/
    let encoded_empty = base64::engine::general_purpose::STANDARD.encode(b"");
    let gitkeep_url = format!(
        "https://api.github.com/repos/{}/{}/contents/{}/projects/.gitkeep",
        owner, REPO_NAME, slug
    );

    let _ = state
        .http_client
        .put(&gitkeep_url)
        .header("Authorization", format!("Bearer {}", pat))
        .header("User-Agent", "cthulu-studio")
        .header("Accept", "application/vnd.github+json")
        .json(&json!({
            "message": format!("Create org projects dir: {}", slug),
            "content": encoded_empty,
        }))
        .send()
        .await;

    Ok(json!({ "ok": true, "slug": slug, "name": name.trim() }))
}
```

- [ ] **Step 3: Add `delete_org` command**

```rust
#[tauri::command]
pub async fn delete_org(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    slug: String,
) -> Result<Value, String> {
    crate::wait_ready(&ready).await?;

    let org_dir = sync_dir(&state).join(&slug);
    if org_dir.exists() {
        std::fs::remove_dir_all(&org_dir)
            .map_err(|e| format!("Failed to remove org directory: {e}"))?;
    }

    // Note: we don't delete from GitHub here to avoid accidental data loss.
    // Users can delete from GitHub directly if needed.

    Ok(json!({ "ok": true }))
}
```

- [ ] **Step 4: Register new commands in main.rs**

In `src-tauri/src/main.rs`, add to the invoke_handler list after line 140:

```rust
    commands::agent_repo::list_orgs,
    commands::agent_repo::create_org,
    commands::agent_repo::delete_org,
```

- [ ] **Step 5: Update `create_agent_project` to accept org parameter**

Modify the existing `create_agent_project` command to accept an `org` parameter. Change the path from `projects/{name}` to `{org}/projects/{name}`:

```rust
#[tauri::command]
pub async fn create_agent_project(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    org: String,           // NEW: org slug
    project: String,
) -> Result<Value, String> {
    // ... validation stays the same ...
    // Change: projects_dir = sync_dir(&state).join(&org).join("projects")
    // Change: GitHub path = "{org}/projects/{name}/.gitkeep"
    // Also write project.json with name, color, status
}
```

- [ ] **Step 6: Update `list_agent_projects` to accept org parameter**

```rust
#[tauri::command]
pub async fn list_agent_projects(
    state: tauri::State<'_, AppState>,
    ready: tauri::State<'_, crate::ReadySignal>,
    org: String,           // NEW: org slug
) -> Result<Value, String> {
    // Change: projects_dir = sync_dir(&state).join(&org).join("projects")
    // Read project.json from each folder for metadata
}
```

- [ ] **Step 7: Update `publish_agent` to accept org parameter**

The path changes from `projects/{project}/{id}/` to `{org}/projects/{project}/{id}/`.

- [ ] **Step 8: Update `unpublish_agent` to use org-aware path**

The agent's `project` field format changes to `{org}/{project}` or we add a separate `org` field.

- [ ] **Step 9: Update `sync_agent_repo` for org-aware structure**

The sync now iterates: top-level dirs (orgs) -> `{org}/projects/` -> project dirs -> agent dirs.

- [ ] **Step 10: Run `cargo check` to verify**

```bash
cd cthulu && cargo check
```

---

## Chunk 2: Frontend — Types, API Client, OrgContext

### Task 2: Add TypeScript Types

**Files:**
- Modify: `src/types/flow.ts`

- [ ] **Step 1: Add Org and Project interfaces**

```typescript
export interface Org {
  slug: string;
  name: string;
  description: string;
}

export interface Project {
  slug: string;
  name: string;
  description: string;
  color: string | null;
  status: "active" | "archived";
}
```

### Task 3: Add API Client Functions

**Files:**
- Modify: `src/api/client.ts`

- [ ] **Step 1: Add org CRUD functions**

```typescript
export async function listOrgs(): Promise<Org[]> {
  const data = await invoke<{ orgs: Org[] }>("list_orgs");
  return data.orgs;
}

export async function createOrg(name: string, description?: string): Promise<{ ok: boolean; slug: string; name: string }> {
  return invoke("create_org", { name, description });
}

export async function deleteOrg(slug: string): Promise<{ ok: boolean }> {
  return invoke("delete_org", { slug });
}
```

- [ ] **Step 2: Update existing project/publish functions to accept org**

```typescript
export async function listAgentProjects(org: string): Promise<string[]> {
  const data = await invoke<{ projects: string[] }>("list_agent_projects", { org });
  return data.projects;
}

export async function createAgentProject(org: string, project: string): Promise<{ ok: boolean; project: string }> {
  return invoke("create_agent_project", { org, project });
}

export async function publishAgent(id: string, org: string, project: string): Promise<{ ok: boolean }> {
  return invoke("publish_agent", { id, org, project });
}
```

### Task 4: Create OrgContext

**Files:**
- Create: `src/contexts/OrgContext.tsx`

- [ ] **Step 1: Create the OrgContext provider**

```typescript
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import * as api from "../api/client";
import type { Org } from "../types/flow";

interface OrgContextValue {
  orgs: Org[];
  selectedOrg: Org | null;
  selectedOrgSlug: string | null;
  loading: boolean;
  setSelectedOrgSlug: (slug: string) => void;
  reloadOrgs: () => Promise<void>;
  createOrg: (name: string, description?: string) => Promise<Org>;
  deleteOrg: (slug: string) => Promise<void>;
}

const OrgContext = createContext<OrgContextValue | null>(null);

export function OrgProvider({ children }: { children: ReactNode }) {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [selectedOrgSlug, setSelectedOrgSlug] = useState<string | null>(() => {
    return localStorage.getItem("cthulu.selectedOrg");
  });
  const [loading, setLoading] = useState(true);

  const reloadOrgs = useCallback(async () => {
    try {
      const list = await api.listOrgs();
      setOrgs(list);
      // Auto-select first org if none selected
      if (!selectedOrgSlug && list.length > 0) {
        setSelectedOrgSlug(list[0].slug);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [selectedOrgSlug]);

  useEffect(() => { reloadOrgs(); }, [reloadOrgs]);

  useEffect(() => {
    if (selectedOrgSlug) {
      localStorage.setItem("cthulu.selectedOrg", selectedOrgSlug);
    }
  }, [selectedOrgSlug]);

  const selectedOrg = orgs.find(o => o.slug === selectedOrgSlug) ?? null;

  const handleCreateOrg = useCallback(async (name: string, description?: string) => {
    const result = await api.createOrg(name, description);
    await reloadOrgs();
    setSelectedOrgSlug(result.slug);
    return { slug: result.slug, name: result.name, description: description ?? "" };
  }, [reloadOrgs]);

  const handleDeleteOrg = useCallback(async (slug: string) => {
    await api.deleteOrg(slug);
    await reloadOrgs();
    if (selectedOrgSlug === slug) {
      setSelectedOrgSlug(orgs[0]?.slug ?? null);
    }
  }, [reloadOrgs, selectedOrgSlug, orgs]);

  return (
    <OrgContext.Provider value={{
      orgs, selectedOrg, selectedOrgSlug, loading,
      setSelectedOrgSlug, reloadOrgs,
      createOrg: handleCreateOrg, deleteOrg: handleDeleteOrg,
    }}>
      {children}
    </OrgContext.Provider>
  );
}

export function useOrg() {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrg must be used within OrgProvider");
  return ctx;
}
```

- [ ] **Step 2: Run `npx nx build cthulu-studio` to verify types compile**

---

## Chunk 3: Frontend — OrgRail Component

### Task 5: Create OrgRail Component

**Files:**
- Create: `src/components/OrgRail.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Create OrgRail.tsx**

A narrow (48px) vertical strip on the far left, showing org initials. Click to switch org. "+" button at bottom to create new org.

```typescript
import { useState } from "react";
import { useOrg } from "../contexts/OrgContext";
import { Plus } from "lucide-react";
import { NewOrgDialog } from "./NewOrgDialog";

export function OrgRail() {
  const { orgs, selectedOrgSlug, setSelectedOrgSlug } = useOrg();
  const [showNewOrg, setShowNewOrg] = useState(false);

  return (
    <div className="org-rail">
      <div className="org-rail-list">
        {orgs.map(org => {
          const initials = org.name.slice(0, 2).toUpperCase();
          const isSelected = org.slug === selectedOrgSlug;
          return (
            <button
              key={org.slug}
              className={`org-rail-item${isSelected ? " org-rail-item-active" : ""}`}
              onClick={() => setSelectedOrgSlug(org.slug)}
              title={org.name}
            >
              {isSelected && <div className="org-rail-indicator" />}
              <div className="org-rail-avatar">{initials}</div>
            </button>
          );
        })}
      </div>
      <button
        className="org-rail-add"
        onClick={() => setShowNewOrg(true)}
        title="Create organization"
      >
        <Plus size={16} />
      </button>
      {showNewOrg && (
        <NewOrgDialog onClose={() => setShowNewOrg(false)} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add OrgRail CSS to styles.css**

```css
/* ── OrgRail ─────────────────────────────────────────────────────── */
.org-rail {
  width: 48px;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  border-right: 1px solid var(--border);
  background: var(--bg);
  flex-shrink: 0;
}
.org-rail-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  overflow-y: auto;
  padding: 4px 0;
}
.org-rail-item {
  position: relative;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  border-radius: 8px;
  transition: background-color 150ms ease;
}
.org-rail-item:hover { background: var(--bg-secondary); }
.org-rail-item-active { background: var(--bg-tertiary); }
.org-rail-indicator {
  position: absolute;
  left: -4px;
  width: 3px;
  height: 20px;
  background: var(--accent);
  border-radius: 0 2px 2px 0;
}
.org-rail-avatar {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  background: var(--bg-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.5px;
}
.org-rail-item-active .org-rail-avatar {
  background: var(--accent);
  color: white;
}
.org-rail-add {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: 1px dashed var(--border);
  border-radius: 8px;
  cursor: pointer;
  color: var(--text-secondary);
  transition: color 150ms ease, border-color 150ms ease;
  margin-top: 4px;
}
.org-rail-add:hover {
  color: var(--text);
  border-color: var(--text-secondary);
}
```

### Task 6: Create NewOrgDialog

**Files:**
- Create: `src/components/NewOrgDialog.tsx`

- [ ] **Step 1: Create NewOrgDialog.tsx**

Simple dialog with name + description inputs. Uses the existing shadcn Dialog component if available, otherwise a plain modal overlay.

```typescript
import { useState, useCallback } from "react";
import { useOrg } from "../contexts/OrgContext";

interface NewOrgDialogProps {
  onClose: () => void;
}

export function NewOrgDialog({ onClose }: NewOrgDialogProps) {
  const { createOrg } = useOrg();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await createOrg(name.trim(), description.trim() || undefined);
      onClose();
    } catch (e) {
      setError(typeof e === "string" ? e : (e instanceof Error ? e.message : String(e)));
    }
    setSaving(false);
  }, [name, description, createOrg, onClose]);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-content" onClick={e => e.stopPropagation()}>
        <h3 className="dialog-title">Create Organization</h3>
        <div className="dialog-field">
          <label>Name</label>
          <input
            type="text" value={name}
            onChange={e => setName(e.target.value)}
            placeholder="My Organization"
            autoFocus
          />
        </div>
        <div className="dialog-field">
          <label>Description (optional)</label>
          <input
            type="text" value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="A brief description"
          />
        </div>
        {error && <p className="dialog-error">{error}</p>}
        <div className="dialog-actions">
          <button className="dialog-btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="dialog-btn-primary"
            onClick={handleSubmit}
            disabled={!name.trim() || saving}
          >
            {saving ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add dialog CSS (if not already present)**

---

## Chunk 4: Frontend — SidebarProjects + NewProjectDialog

### Task 7: Create SidebarProjects Component

**Files:**
- Create: `src/components/SidebarProjects.tsx`

- [ ] **Step 1: Create SidebarProjects.tsx**

A collapsible section in the sidebar that lists projects for the selected org, with agents nested inside each project.

```typescript
import { useState, useEffect, useMemo, useCallback } from "react";
import * as api from "../api/client";
import type { AgentSummary } from "../types/flow";
import { useOrg } from "../contexts/OrgContext";
import { ChevronRight, Plus, FolderOpen } from "lucide-react";
import { STUDIO_ASSISTANT_ID } from "../types/flow";

interface SidebarProjectsProps {
  agents: AgentSummary[];
  onSelectAgent: (agentId: string) => void;
  selectedAgentId: string | null;
}

export function SidebarProjects({ agents, onSelectAgent, selectedAgentId }: SidebarProjectsProps) {
  const { selectedOrgSlug } = useOrg();
  const [projects, setProjects] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showNewProject, setShowNewProject] = useState(false);

  useEffect(() => {
    if (!selectedOrgSlug) return;
    api.listAgentProjects(selectedOrgSlug).then(setProjects).catch(() => {});
  }, [selectedOrgSlug]);

  // Group agents by project
  const agentsByProject = useMemo(() => {
    const map = new Map<string, AgentSummary[]>();
    for (const project of projects) {
      map.set(project, []);
    }
    for (const agent of agents) {
      if (agent.id === STUDIO_ASSISTANT_ID) continue;
      if (agent.project) {
        // project format: "project-name" (within current org)
        const list = map.get(agent.project) ?? [];
        list.push(agent);
        map.set(agent.project, list);
      }
    }
    return map;
  }, [agents, projects]);

  const toggleProject = useCallback((project: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  }, []);

  return (
    <>
      {projects.map(project => {
        const isExpanded = expanded.has(project);
        const projectAgents = agentsByProject.get(project) ?? [];
        return (
          <div key={project} className="sb-project-group">
            <button className="sb-project-header" onClick={() => toggleProject(project)}>
              <ChevronRight
                size={12}
                className={`sb-project-chevron${isExpanded ? " sb-project-chevron-open" : ""}`}
              />
              <FolderOpen size={14} className="sb-project-icon" />
              <span className="sb-project-name">{project}</span>
              <span className="sb-project-count">{projectAgents.length}</span>
            </button>
            {isExpanded && (
              <div className="sb-project-agents">
                {projectAgents.length === 0 ? (
                  <div className="sb-project-empty">No agents</div>
                ) : (
                  projectAgents.map(agent => (
                    <button
                      key={agent.id}
                      className={`sb-agent-item sb-project-agent${selectedAgentId === agent.id ? " sb-agent-item-active" : ""}`}
                      onClick={() => onSelectAgent(agent.id)}
                    >
                      <span className="sb-agent-name">{agent.name}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
      <button className="sb-project-add" onClick={() => setShowNewProject(true)}>
        <Plus size={12} />
        New Project
      </button>
      {/* NewProjectDialog would go here */}
    </>
  );
}
```

- [ ] **Step 2: Add SidebarProjects CSS to styles.css**

### Task 8: Create NewProjectDialog

**Files:**
- Create: `src/components/NewProjectDialog.tsx`

- [ ] **Step 1: Create NewProjectDialog.tsx**

Similar to NewOrgDialog but for projects within the selected org.

---

## Chunk 5: Frontend — Wire Everything Together

### Task 9: Update Sidebar to include Projects section

**Files:**
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Import and render SidebarProjects**

Add a "Projects" collapsible section between the agents list header and the agents list. The Projects section shows projects with nested agents. The Agents section below shows unassigned agents (those without a project).

### Task 10: Update App.tsx Layout

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add OrgProvider to context stack**

Wrap the existing providers with `<OrgProvider>`:

```tsx
<UIProvider>
  <OrgProvider>
    <NavigationProvider>
      ...
    </NavigationProvider>
  </OrgProvider>
</UIProvider>
```

- [ ] **Step 2: Add OrgRail to the layout**

In the `app-layout` div, add `<OrgRail />` before the sidebar:

```tsx
<div className="app-layout">
  <OrgRail />
  <Sidebar ... />
  <main>...</main>
</div>
```

- [ ] **Step 3: Update app-layout CSS for three-column grid**

Change the grid from `auto 1fr` to `48px auto 1fr` to accommodate the OrgRail.

### Task 11: Scope Agent List to Selected Org

**Files:**
- Modify: `src/components/AgentListPage.tsx`
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Filter agents by selected org's project assignments**

In `AgentListPage`, use `useOrg()` to get `selectedOrgSlug`. Filter the agents list to show only agents whose `project` field matches a project in the selected org.

- [ ] **Step 2: Update Sidebar agent list similarly**

### Task 12: Update setup_agent_repo to create default org

**Files:**
- Modify: `src-tauri/src/commands/agent_repo.rs`

- [ ] **Step 1: After repo creation, create a default org folder**

When `setup_agent_repo` creates the repo, also create a default org folder (using the GitHub username as the org name).

---

## Chunk 6: Build Verification

### Task 13: Verify Everything Compiles

- [ ] **Step 1: Run `cargo check`**
- [ ] **Step 2: Run `npx nx build cthulu-studio`**
- [ ] **Step 3: Run `npx nx dev cthulu-studio` and verify visually**
