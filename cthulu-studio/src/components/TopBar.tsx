import { useState, useEffect, useRef } from "react";
import * as api from "../api/client";
import { log } from "../api/logger";
import type { FlowNode } from "../types/flow";

interface TopBarProps {
  flow: { name: string; enabled: boolean } | null;
  onTrigger: () => void;
  onToggleEnabled: () => void;
  onSettingsClick: () => void;
  consoleOpen: boolean;
  onToggleConsole: () => void;
  runLogOpen: boolean;
  onToggleRunLog: () => void;
  errorCount: number;
  flowHasErrors?: boolean;
  validationErrors?: Record<string, string[]>;
  flowNodes?: FlowNode[];
}

export default function TopBar({
  flow,
  onTrigger,
  onToggleEnabled,
  onSettingsClick,
  consoleOpen,
  onToggleConsole,
  runLogOpen,
  onToggleRunLog,
  errorCount,
  flowHasErrors,
  validationErrors,
  flowNodes,
}: TopBarProps) {
  const [connected, setConnected] = useState(false);
  const [showValidationGate, setShowValidationGate] = useState(false);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-dismiss gate when errors are fixed
  useEffect(() => {
    if (!flowHasErrors) setShowValidationGate(false);
  }, [flowHasErrors]);

  useEffect(() => {
    let cancelled = false;

    // Fast retry on boot: 1s, 2s, 3s... then settle at 10s
    const check = async (interval: number) => {
      if (cancelled) return;
      const ok = await api.checkConnection();
      if (!cancelled) {
        const wasDisconnected = !connected;
        setConnected(ok);

        if (ok && wasDisconnected) {
          log("info", `Connected to server at ${api.getServerUrl()}`);
        }

        // If still disconnected, retry faster (up to 10s)
        const nextInterval = ok ? 10000 : Math.min(interval + 1000, 10000);
        retryRef.current = setTimeout(() => check(nextInterval), nextInterval);
      }
    };

    check(1000);

    return () => {
      cancelled = true;
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, []);

  const handleRunClick = () => {
    if (flowHasErrors) {
      setShowValidationGate(true);
    } else {
      onTrigger();
    }
  };

  const handleRunAnyway = () => {
    setShowValidationGate(false);
    onTrigger();
  };

  const nodeMap = new Map((flowNodes ?? []).map((n) => [n.id, n]));

  return (
    <>
      <div className="top-bar">
        <h1>Cthulu Studio</h1>
        {flow && (
          <>
            <span className="flow-name">{flow.name}</span>
            <button className="ghost" onClick={onToggleEnabled}>
              {flow.enabled ? "Enabled" : "Disabled"}
            </button>
          </>
        )}
        <div className="spacer" />
        {flow && (
          <button className="primary" onClick={handleRunClick} disabled={!connected}>
            Run
          </button>
        )}
        <div className="connection-status">
          <div
            className={`connection-dot ${connected ? "connected" : "disconnected"}`}
          />
          <span>{connected ? api.getServerUrl() : "Disconnected"}</span>
        </div>
        <button
          className={`ghost ${runLogOpen ? "console-toggle-active" : ""}`}
          onClick={onToggleRunLog}
        >
          Log
        </button>
        <button
          className={`ghost ${consoleOpen ? "console-toggle-active" : ""}`}
          onClick={onToggleConsole}
          style={{ position: "relative" }}
        >
          Console
          {errorCount > 0 && !consoleOpen && (
            <span className="error-badge">{errorCount}</span>
          )}
        </button>
        <button className="ghost" onClick={onSettingsClick}>
          Settings
        </button>
      </div>

      {showValidationGate && validationErrors && (
        <div className="validation-gate-overlay" onClick={() => setShowValidationGate(false)}>
          <div className="validation-gate" onClick={(e) => e.stopPropagation()}>
            <div className="validation-gate-header">
              Flow has validation errors
            </div>
            <div className="validation-gate-body">
              {Object.entries(validationErrors).map(([nodeId, errs]) => {
                const node = nodeMap.get(nodeId);
                return (
                  <div key={nodeId} className="validation-gate-node">
                    <strong>{node?.label ?? nodeId}</strong>
                    <span className="validation-gate-kind">{node?.kind}</span>
                    <ul>
                      {errs.map((err, i) => (
                        <li key={i}>{err}</li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
            <div className="validation-gate-footer">
              <button className="ghost" onClick={() => setShowValidationGate(false)}>
                Cancel
              </button>
              <button className="danger" onClick={handleRunAnyway}>
                Run Anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
