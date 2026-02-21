import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import * as api from "./api/client";
import { log, getEntries, subscribe } from "./api/logger";
import { subscribeToRuns } from "./api/runStream";
import type { Flow, FlowNode, FlowEdge, FlowSummary, NodeTypeSchema, RunEvent } from "./types/flow";
import { validateFlow } from "./utils/validateNode";
import TopBar from "./components/TopBar";
import FlowList from "./components/FlowList";
import Sidebar from "./components/Sidebar";
import Canvas, { type CanvasHandle } from "./components/Canvas";
import PropertyPanel from "./components/PropertyPanel";
import RunHistory from "./components/RunHistory";
import Console from "./components/Console";
import RunLog from "./components/RunLog";
import InteractPanel, { type InteractPanelState } from "./components/InteractPanel";
import ErrorBoundary from "./components/ErrorBoundary";

export default function App() {
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [activeFlowId, setActiveFlowId] = useState<string | null>(null);
  const [initialFlow, setInitialFlow] = useState<Flow | null>(null);
  const [nodeTypes, setNodeTypes] = useState<NodeTypeSchema[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  const [showRunLog, setShowRunLog] = useState(false);
  const [showInteract, setShowInteract] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [errorCount, setErrorCount] = useState(0);
  const sessionsRef = useRef<Map<string, InteractPanelState>>(new Map());
  const [serverUrl, setServerUrlState] = useState(api.getServerUrl());
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [nodeRunStatus, setNodeRunStatus] = useState<Record<string, "running" | "completed" | "failed">>({});
  // Keep a light reference for TopBar (name, enabled) without driving Canvas
  const [activeFlowMeta, setActiveFlowMeta] = useState<{ id: string; name: string; description: string; enabled: boolean } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvasRef = useRef<CanvasHandle>(null);

  // --- Validation state ---
  const latestSnapshotRef = useRef<{ nodes: FlowNode[]; edges: FlowEdge[] } | null>(null);
  const [snapshotVersion, setSnapshotVersion] = useState(0);

  const nodeValidationErrors = useMemo(() => {
    // snapshotVersion used as dependency trigger
    void snapshotVersion;
    return latestSnapshotRef.current ? validateFlow(latestSnapshotRef.current.nodes) : {};
  }, [snapshotVersion]);
  const flowHasErrors = Object.keys(nodeValidationErrors).length > 0;

  // --- Drag-and-drop state (refs to avoid re-renders during drag) ---
  const dragging = useRef<NodeTypeSchema | null>(null);
  const ghostEl = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!ghostEl.current) return;
      ghostEl.current.style.left = `${e.clientX + 12}px`;
      ghostEl.current.style.top = `${e.clientY + 12}px`;
    };

    const onMouseUp = (e: MouseEvent) => {
      const nt = dragging.current;
      if (!nt) return;
      dragging.current = null;

      // Clean up ghost
      ghostEl.current?.remove();
      ghostEl.current = null;
      document.body.style.cursor = "";

      // Hit-test: is the cursor over the canvas?
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el?.closest(".canvas-container")) return;

      // Place the node — Canvas owns state, no need to update App
      canvasRef.current?.addNodeAtScreen(
        nt.node_type, nt.kind, nt.label, e.clientX, e.clientY
      );
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const handleGrab = useCallback((nodeType: NodeTypeSchema) => {
    dragging.current = nodeType;
    document.body.style.cursor = "grabbing";

    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = nodeType.label;
    document.body.appendChild(ghost);
    ghostEl.current = ghost;
  }, []);

  // --- Error count badge ---
  useEffect(() => {
    return subscribe(() => {
      const errors = getEntries().filter((e) => e.level === "error").length;
      setErrorCount(errors);
    });
  }, []);

  // --- SSE run event subscription ---
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleRunEvent = useCallback((event: RunEvent) => {
    setRunEvents((prev) => {
      const next = [...prev, event];
      return next.length > 500 ? next.slice(-500) : next;
    });

    // Reset node statuses at start of a new run
    if (event.event_type === "run_started") {
      if (clearTimer.current) clearTimeout(clearTimer.current);
      setNodeRunStatus({});
    }

    // Update node run status for canvas highlighting
    if (event.node_id) {
      if (event.event_type === "node_started") {
        setNodeRunStatus((prev) => ({ ...prev, [event.node_id!]: "running" }));
      } else if (event.event_type === "node_completed") {
        setNodeRunStatus((prev) => ({ ...prev, [event.node_id!]: "completed" }));
      } else if (event.event_type === "node_failed") {
        setNodeRunStatus((prev) => ({ ...prev, [event.node_id!]: "failed" }));
      }
    }

    // Clear all node statuses a while after a run finishes
    if (event.event_type === "run_completed" || event.event_type === "run_failed") {
      clearTimer.current = setTimeout(() => setNodeRunStatus({}), 10000);
    }
  }, []);

  useEffect(() => {
    if (!activeFlowId) return;
    setRunEvents([]);
    setNodeRunStatus({});
    const cleanup = subscribeToRuns(activeFlowId, handleRunEvent);
    return cleanup;
  }, [activeFlowId, handleRunEvent]);

  // --- Boot ---
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    log("info", "Cthulu Studio started");
    log("info", `Server URL: ${api.getServerUrl()}`);
    loadFlows();
    loadNodeTypes();
  }, []);

  // --- API helpers ---
  const loadFlows = async () => {
    try { setFlows(await api.listFlows()); } catch { /* logged */ }
  };

  const loadNodeTypes = async () => {
    try { setNodeTypes(await api.getNodeTypes()); } catch { /* logged */ }
  };

  const selectFlow = async (id: string) => {
    try {
      const flow = await api.getFlow(id);
      setInitialFlow(flow);
      setActiveFlowId(flow.id);
      setActiveFlowMeta({ id: flow.id, name: flow.name, description: flow.description, enabled: flow.enabled });
      setSelectedNodeId(null);
    } catch { /* logged */ }
  };

  const createFlow = async () => {
    try {
      const { id } = await api.createFlow("New Flow");
      await loadFlows();
      await selectFlow(id);
    } catch { /* logged */ }
  };

  // --- Snapshot callback: Canvas pushes state here for persistence ---
  const handleFlowSnapshot = useCallback((snapshot: { nodes: FlowNode[]; edges: FlowEdge[] }) => {
    latestSnapshotRef.current = snapshot;
    setSnapshotVersion((v) => v + 1);
    if (!activeFlowId || !activeFlowMeta) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await api.updateFlow(activeFlowId, {
          name: activeFlowMeta.name,
          description: activeFlowMeta.description,
          enabled: activeFlowMeta.enabled,
          nodes: snapshot.nodes,
          edges: snapshot.edges,
        });
        loadFlows();
      } catch { /* logged */ }
    }, 500);
  }, [activeFlowId, activeFlowMeta]);

  const handleSelectionChange = useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId);
  }, []);

  const handleTrigger = async () => {
    if (!activeFlowMeta) return;
    try {
      log("info", `Triggering flow: ${activeFlowMeta.name}`);
      setShowRunLog(true);
      await api.triggerFlow(activeFlowMeta.id);
    } catch { /* logged */ }
  };

  const handleToggleEnabled = async () => {
    if (!activeFlowMeta) return;
    const updated = { ...activeFlowMeta, enabled: !activeFlowMeta.enabled };
    setActiveFlowMeta(updated);
    try {
      await api.updateFlow(activeFlowMeta.id, { enabled: updated.enabled });
      loadFlows();
    } catch { /* logged */ }
  };

  const handleToggleInteract = useCallback(() => {
    setShowInteract((v) => {
      if (!v) {
        // Opening interact — close other bottom panels
        setShowConsole(false);
        setShowRunLog(false);
      }
      return !v;
    });
  }, []);

  const handleInteractStateChange = useCallback((state: InteractPanelState) => {
    if (activeFlowId) {
      sessionsRef.current.set(activeFlowId, state);
    }
  }, [activeFlowId]);

  const handleDeleteFlow = async () => {
    if (!activeFlowId) return;
    // If there's session history in any tab, show the confirmation dialog
    const panelState = sessionsRef.current.get(activeFlowId);
    if (panelState) {
      const hasHistory = Object.values(panelState.tabs).some(
        (tab) => tab.outputLines.length > 0
      );
      if (hasHistory) {
        setShowDeleteConfirm(true);
        return;
      }
    }
    // No session history — delete directly
    await doDeleteFlow();
  };

  const doDeleteFlow = async () => {
    if (!activeFlowId) return;
    try {
      await api.deleteFlow(activeFlowId);
      sessionsRef.current.delete(activeFlowId);
      setShowInteract(false);
      setShowDeleteConfirm(false);
      setActiveFlowId(null);
      setInitialFlow(null);
      setActiveFlowMeta(null);
      setSelectedNodeId(null);
      loadFlows();
    } catch { /* logged */ }
  };

  const handleSaveAndDelete = async () => {
    if (!activeFlowId || !activeFlowMeta) return;
    setDeleteSaving(true);
    try {
      const panelState = sessionsRef.current.get(activeFlowId);
      // Gather output from all tabs into a single transcript
      const allLines = panelState
        ? Object.values(panelState.tabs).flatMap((tab) => tab.outputLines)
        : [];
      const transcript = allLines
        .map((l) => `[${l.type}] ${l.text}`)
        .join("\n");
      const result = await api.summarizeSession(
        transcript,
        activeFlowMeta.name,
        activeFlowMeta.description
      );
      await api.savePrompt({
        title: result.title,
        summary: result.summary,
        source_flow_name: activeFlowMeta.name,
        tags: result.tags,
      });
      log("info", `Saved session summary as prompt: ${result.title}`);
    } catch (err) {
      log("error", `Failed to save session summary: ${(err as Error).message}`);
    }
    setDeleteSaving(false);
    await doDeleteFlow();
  };

  const handleSaveSettings = () => {
    api.setServerUrl(serverUrl);
    setShowSettings(false);
    loadFlows();
    loadNodeTypes();
  };

  return (
    <div className={showConsole || showRunLog || showInteract ? "app-with-console" : ""}>
      <TopBar
        flow={activeFlowMeta}
        onTrigger={handleTrigger}
        onToggleEnabled={handleToggleEnabled}
        onSettingsClick={() => setShowSettings(true)}
        interactOpen={showInteract}
        onToggleInteract={handleToggleInteract}
        consoleOpen={showConsole}
        onToggleConsole={() => {
          setShowConsole((v) => {
            if (!v) { setShowRunLog(false); setShowInteract(false); }
            return !v;
          });
        }}
        runLogOpen={showRunLog}
        onToggleRunLog={() => {
          setShowRunLog((v) => {
            if (!v) { setShowConsole(false); setShowInteract(false); }
            return !v;
          });
        }}
        errorCount={errorCount}
        flowHasErrors={flowHasErrors}
        validationErrors={nodeValidationErrors}
        flowNodes={latestSnapshotRef.current?.nodes ?? []}
      />
      <div className="app-layout">
        <div style={{ display: "flex", flexDirection: "column" }}>
          <FlowList
            flows={flows}
            activeFlowId={activeFlowId}
            onSelect={selectFlow}
            onCreate={createFlow}
          />
          <Sidebar nodeTypes={nodeTypes} onGrab={handleGrab} />
        </div>

        {activeFlowId ? (
          <ErrorBoundary>
            <Canvas
              ref={canvasRef}
              flowId={activeFlowId}
              initialFlow={initialFlow}
              onFlowSnapshot={handleFlowSnapshot}
              onSelectionChange={handleSelectionChange}
              nodeRunStatus={nodeRunStatus}
              nodeValidationErrors={nodeValidationErrors}
            />
          </ErrorBoundary>
        ) : (
          <div className="canvas-container">
            <div className="empty-state">
              <p>Select a flow or create a new one</p>
            </div>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column" }}>
          <PropertyPanel
            canvasRef={canvasRef}
            selectedNodeId={selectedNodeId}
            nodeValidationErrors={nodeValidationErrors}
          />
          <RunHistory flowId={activeFlowId} />
          {activeFlowId && (
            <div style={{ padding: 16 }}>
              <button className="danger" onClick={handleDeleteFlow}>
                Delete Flow
              </button>
            </div>
          )}
        </div>
      </div>

      {showRunLog && !showInteract && <RunLog events={runEvents} onClear={() => setRunEvents([])} onClose={() => setShowRunLog(false)} />}
      {showConsole && !showRunLog && !showInteract && <Console onClose={() => setShowConsole(false)} />}
      {showInteract && activeFlowId && (
        <InteractPanel
          key={activeFlowId}
          flowId={activeFlowId}
          onClose={() => setShowInteract(false)}
          initialState={sessionsRef.current.get(activeFlowId) ?? null}
          onStateChange={handleInteractStateChange}
        />
      )}

      {showDeleteConfirm && (
        <div className="modal-overlay" onClick={() => setShowDeleteConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete Flow</h2>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
              This flow has an interact session with history. Would you like to save a summary to the Prompts Library before deleting?
            </p>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </button>
              <button className="danger" onClick={doDeleteFlow}>
                Delete Only
              </button>
              <button className="primary" onClick={handleSaveAndDelete} disabled={deleteSaving}>
                {deleteSaving ? "Saving..." : "Save & Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Server Settings</h2>
            <div className="form-group">
              <label>Server URL</label>
              <input
                value={serverUrl}
                onChange={(e) => setServerUrlState(e.target.value)}
                placeholder="http://localhost:8081"
              />
            </div>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setShowSettings(false)}>
                Cancel
              </button>
              <button className="primary" onClick={handleSaveSettings}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
