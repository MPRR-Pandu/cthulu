import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import * as api from "../api/client";
import type { WorkflowSummary, TemplateMetadata } from "../types/flow";
import GitHubPatDialog from "./GitHubPatDialog";
import CreateWorkflowDialog from "./CreateWorkflowDialog";
import TemplateGallery from "./TemplateGallery";

interface WorkflowsViewProps {
  onOpenWorkflow: (workspace: string, name: string) => void;
  onWorkflowsChanged?: (workspaces: string[], workflows: WorkflowSummary[]) => void;
  /** Increment to trigger the template gallery from outside (e.g. sidebar "+" button) */
  newWorkflowTrigger?: number;
  /** Controlled active workspace — owned by parent (App.tsx) */
  activeWorkspace?: string | null;
  /** Notify parent when workspace should change */
  onSelectWorkspace?: (ws: string) => void;
}

export default function WorkflowsView({ onOpenWorkflow, onWorkflowsChanged, newWorkflowTrigger, activeWorkspace, onSelectWorkspace }: WorkflowsViewProps) {
  const [patConfigured, setPatConfigured] = useState<boolean | null>(null);
  const [showPatDialog, setShowPatDialog] = useState(false);
  const [showNewWorkflow, setShowNewWorkflow] = useState(false);
  const [repoReady, setRepoReady] = useState(false);
  const [setting, setSetting] = useState(false);

  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTemplateGallery, setShowTemplateGallery] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateMetadata | null>(null);
  const [cachedTemplates, setCachedTemplates] = useState<TemplateMetadata[] | undefined>(undefined);

  useEffect(() => {
    api.getGithubPatStatus()
      .then((res) => setPatConfigured(res.configured))
      .catch(() => setPatConfigured(false));
  }, []);

  const setupRepo = useCallback(async () => {
    setSetting(true);
    setError(null);
    try {
      await api.setupWorkflows();
      setRepoReady(true);
      const res = await api.listWorkspaces();
      setWorkspaces(res.workspaces);
      if (res.workspaces.length > 0) {
        onSelectWorkspace?.(res.workspaces[0]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSetting(false);
    }
  }, []);

  const handlePatSaved = useCallback(() => {
    setPatConfigured(true);
    setupRepo();
  }, [setupRepo]);

  useEffect(() => {
    if (patConfigured === true && !repoReady) {
      setupRepo();
    }
  }, [patConfigured, repoReady, setupRepo]);

  const refreshWorkflows = useCallback(async (ws: string | null) => {
    if (!ws || !repoReady) { setWorkflows([]); return; }
    try {
      const res = await api.listWorkflows(ws);
      setWorkflows(res.workflows);
    } catch { setWorkflows([]); }
  }, [repoReady]);

  useEffect(() => {
    refreshWorkflows(activeWorkspace ?? null);
  }, [activeWorkspace, repoReady, refreshWorkflows]);

  // Eagerly fetch templates once when repo is ready (cached for TemplateGallery)
  useEffect(() => {
    if (repoReady && !cachedTemplates) {
      api.listTemplates().then(setCachedTemplates).catch(() => {});
    }
  }, [repoReady, cachedTemplates]);

  // Sync state to parent so sidebar stays up to date
  useEffect(() => {
    onWorkflowsChanged?.(workspaces, workflows);
  }, [workspaces, workflows, onWorkflowsChanged]);

  // External trigger to open the template gallery (e.g. sidebar "+" button)
  const prevTriggerRef = useRef(newWorkflowTrigger);
  useEffect(() => {
    if (newWorkflowTrigger && newWorkflowTrigger !== prevTriggerRef.current) {
      prevTriggerRef.current = newWorkflowTrigger;
      setShowTemplateGallery(true);
    }
  }, [newWorkflowTrigger]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await api.syncWorkflows();
      setWorkspaces(res.workspaces);
      if (activeWorkspace) {
        await refreshWorkflows(activeWorkspace);
      }
    } catch {
      // logged
    } finally {
      setSyncing(false);
    }
  };

  const handleWorkflowCreated = async (workspace: string, name: string) => {
    // Optimistically add the new workflow to the list immediately
    setWorkflows((prev) => {
      if (prev.some((wf) => wf.name === name && wf.workspace === workspace)) return prev;
      return [...prev, { name, workspace, description: "", node_count: 0 }];
    });
    // Then refresh from backend to get accurate data
    await refreshWorkflows(workspace);
  };

  if (patConfigured === null) {
    return (
      <div className="workflows-view">
        <div className="workflows-empty">Checking configuration...</div>
      </div>
    );
  }

  if (!patConfigured) {
    return (
      <div className="workflows-view">
        <div className="workflows-empty">
          <p>Connect your GitHub account to store and sync workflows.</p>
          <Button onClick={() => setShowPatDialog(true)} className="mt-4">
            Connect GitHub
          </Button>
        </div>
        <GitHubPatDialog
          open={showPatDialog}
          onOpenChange={setShowPatDialog}
          onSaved={handlePatSaved}
        />
      </div>
    );
  }

  if (setting) {
    return (
      <div className="workflows-view">
        <div className="workflows-empty">Setting up workflows repository...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="workflows-view">
        <div className="workflows-empty">
          <p className="text-[var(--danger)]">{error}</p>
          <Button onClick={setupRepo} className="mt-4">Retry</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="workflows-view">
      <div className="workflows-toolbar">
        <div className="spacer" />
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSync}
          disabled={syncing}
        >
          {syncing ? "Syncing..." : "Sync"}
        </Button>
      </div>

      <div className="workflow-grid">
        {workflows.map((wf) => (
          <div
            key={wf.name}
            className="workflow-card"
            onClick={() => onOpenWorkflow(wf.workspace, wf.name)}
          >
            <div className="workflow-card-name">{wf.name}</div>
            {wf.description && (
              <div className="workflow-card-desc">{wf.description}</div>
            )}
            <div className="workflow-card-meta">
              {wf.node_count} node{wf.node_count !== 1 ? "s" : ""}
            </div>
          </div>
        ))}
        {activeWorkspace && (
          <div
            className="workflow-card workflow-card-new"
            onClick={() => setShowTemplateGallery(true)}
          >
            <div className="workflow-card-name">+ New Workflow</div>
          </div>
        )}
      </div>

      {showTemplateGallery && (
        <TemplateGallery
          cachedTemplates={cachedTemplates}
          onSelectTemplate={(tmpl) => {
            setSelectedTemplate(tmpl);
            setShowTemplateGallery(false);
            setShowNewWorkflow(true);
          }}
          onBlank={() => {
            setSelectedTemplate(null);
            setShowTemplateGallery(false);
            setShowNewWorkflow(true);
          }}
          onClose={() => setShowTemplateGallery(false)}
          onImport={() => {/* unused in workflow mode */}}
        />
      )}

      {activeWorkspace && (
        <CreateWorkflowDialog
          open={showNewWorkflow}
          onOpenChange={setShowNewWorkflow}
          workspace={activeWorkspace}
          onCreated={handleWorkflowCreated}
          template={selectedTemplate}
        />
      )}
    </div>
  );
}
