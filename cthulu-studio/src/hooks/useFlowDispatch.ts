import { useState, useCallback, useRef } from "react";
import type { Flow } from "../types/flow";

export type UpdateSource = "canvas" | "editor" | "server" | "init" | "app";
export interface UpdateSignal { counter: number; source: UpdateSource; }

export interface FlowDispatchAPI {
  /** Called after saves/conflicts to notify the host (e.g. refresh sidebar). */
  onSaveComplete?: () => void;
  /** Persist a flow to the server. */
  updateFlow: (
    id: string,
    updates: {
      name?: string;
      description?: string;
      nodes?: Flow["nodes"];
      edges?: Flow["edges"];
      version?: number;
    }
  ) => Promise<Flow>;
  /** Fetch a single flow from the server (used on 409 conflict). */
  getFlow: (id: string) => Promise<Flow>;
}

export interface UseFlowDispatchReturn {
  canonicalFlow: Flow | null;
  updateSignal: UpdateSignal;
  flowVersionRef: React.RefObject<number>;
  dispatchFlowUpdate: (source: UpdateSource, updates: Partial<Flow>) => void;
  initFlow: (flow: Flow) => void;
}

export function useFlowDispatch(
  api: FlowDispatchAPI,
  activeFlowIdRef: React.RefObject<string | null>,
): UseFlowDispatchReturn {
  const [canonicalFlow, setCanonicalFlow] = useState<Flow | null>(null);
  const [updateSignal, setUpdateSignal] = useState<UpdateSignal>({ counter: 0, source: "init" });

  const updateCounterRef = useRef(0);
  const flowVersionRef = useRef<number>(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canonicalFlowRef = useRef<Flow | null>(null);

  const dispatchFlowUpdate = useCallback((source: UpdateSource, updates: Partial<Flow>) => {
    const prev = canonicalFlowRef.current;
    if (!prev) return;

    // Strip metadata-only fields and compare the rest — if nothing
    // meaningful changed, skip the dispatch entirely to prevent save loops.
    // Inverse allowlist: only these fields are ignored for diff purposes.
    const next = { ...prev, ...updates };
    const { version: _v1, created_at: _c1, updated_at: _u1, id: _i1, ...prevContent } = prev;
    const { version: _v2, created_at: _c2, updated_at: _u2, id: _i2, ...nextContent } = next;
    const meaningfulChange = JSON.stringify(prevContent) !== JSON.stringify(nextContent);

    if (!meaningfulChange) {
      // Silently update version if provided (no signal bump, no save)
      if (updates.version !== undefined && updates.version !== prev.version) {
        flowVersionRef.current = updates.version;
        const versioned = { ...prev, version: updates.version };
        canonicalFlowRef.current = versioned;
        setCanonicalFlow(versioned);
      }
      return;
    }

    setCanonicalFlow(next);
    canonicalFlowRef.current = next;

    // Bump update signal
    updateCounterRef.current += 1;
    const counter = updateCounterRef.current;
    setUpdateSignal({ counter, source });

    // Update version if provided
    if (updates.version !== undefined) {
      flowVersionRef.current = updates.version;
    }

    // Debounced API save (skip for server-originated and init updates)
    if (source !== "server" && source !== "init") {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        const flowId = activeFlowIdRef.current;
        if (!flowId) return;

        const currentFlow = canonicalFlowRef.current;
        if (!currentFlow) return;

        try {
          const updated = await api.updateFlow(flowId, {
            name: currentFlow.name,
            description: currentFlow.description,
            nodes: currentFlow.nodes,
            edges: currentFlow.edges,
            version: flowVersionRef.current,
          });
          // Silently update version without bumping updateSignal
          flowVersionRef.current = updated.version;
          setCanonicalFlow((prev) =>
            prev ? { ...prev, version: updated.version } : prev
          );
          api.onSaveComplete?.();
        } catch (e) {
          // On 409 Conflict, re-fetch and dispatch as server update
          if (e instanceof Error && e.message.includes("409")) {
            try {
              const fresh = await api.getFlow(flowId);
              flowVersionRef.current = fresh.version;
              dispatchFlowUpdate("server", {
                nodes: fresh.nodes,
                edges: fresh.edges,
                name: fresh.name,
                description: fresh.description,
                enabled: fresh.enabled,
                version: fresh.version,
              });
              api.onSaveComplete?.();
            } catch { /* logged */ }
          }
        }
      }, 500);
    }
  }, [api, activeFlowIdRef]);

  const initFlow = useCallback((flow: Flow) => {
    // Cancel any pending save from the previous flow
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }

    setCanonicalFlow(flow);
    canonicalFlowRef.current = flow;
    flowVersionRef.current = flow.version;

    // Bump update signal with "init" source so consumers seed from it
    updateCounterRef.current += 1;
    setUpdateSignal({ counter: updateCounterRef.current, source: "init" });
  }, []);

  return {
    canonicalFlow,
    updateSignal,
    flowVersionRef,
    dispatchFlowUpdate,
    initFlow,
  };
}
