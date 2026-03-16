import { useState, useCallback } from "react";
import { useCloud } from "../../contexts/CloudContext";

export default function CloudSection() {
  const cloud = useCloud();
  const [urlDraft, setUrlDraft] = useState(cloud.cloudUrl);

  const handleUrlBlur = useCallback(() => {
    const trimmed = urlDraft.trim();
    if (trimmed && trimmed !== cloud.cloudUrl) {
      cloud.setCloudUrl(trimmed);
    }
  }, [urlDraft, cloud]);

  const handleUrlKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        (e.target as HTMLInputElement).blur();
      }
    },
    [],
  );

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span className="settings-section-title">Cthulu Cloud</span>
        <label className="cloud-toggle">
          <input
            type="checkbox"
            checked={cloud.enabled}
            onChange={(e) => cloud.setEnabled(e.target.checked)}
          />
          <span className="cloud-toggle-slider" />
        </label>
      </div>

      {cloud.enabled && (
        <div className="settings-section-body">
          {/* Cloud URL */}
          <div className="settings-row">
            <span className="settings-label">Cloud URL</span>
            <input
              className="settings-input"
              type="text"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onBlur={handleUrlBlur}
              onKeyDown={handleUrlKeyDown}
              placeholder="http://localhost:8080"
            />
          </div>

          {/* Connection Status */}
          <div className="cloud-status-group">
            <div className="settings-label">Connection Status</div>
            <div className="cloud-status-rows">
              <div className="cloud-status-row">
                <span
                  className={`status-dot ${cloud.cloudApiOk ? "ok" : cloud.connected ? "unknown" : "error"}`}
                />
                <span className="cloud-status-label">Cloud API:</span>
                <span className="cloud-status-value">
                  {cloud.cloudApiOk
                    ? "Connected"
                    : cloud.loading
                      ? "Connecting..."
                      : "Disconnected"}
                </span>
              </div>
              <div className="cloud-status-row">
                <span
                  className={`status-dot ${cloud.githubPatOk ? "ok" : "unknown"}`}
                />
                <span className="cloud-status-label">GitHub PAT:</span>
                <span className="cloud-status-value">
                  {cloud.githubPatOk ? "Valid" : "Unknown"}
                </span>
              </div>
              <div className="cloud-status-row">
                <span
                  className={`status-dot ${cloud.claudeCliOk ? "ok" : "unknown"}`}
                />
                <span className="cloud-status-label">Claude CLI:</span>
                <span className="cloud-status-value">
                  {cloud.claudeCliOk ? "Active" : "Unknown"}
                </span>
              </div>
            </div>
          </div>

          {/* Stats */}
          {cloud.connected && (
            <div className="cloud-stats">
              <div className="cloud-stat">
                <span className="cloud-stat-value">{cloud.agents.length}</span>
                <span className="cloud-stat-label">Cloud Agents</span>
              </div>
              <div className="cloud-stat">
                <span className="cloud-stat-value">{cloud.tasks.length}</span>
                <span className="cloud-stat-label">Recent Tasks</span>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="cloud-actions">
            <button
              className="cloud-action-btn"
              onClick={() => cloud.testConnection()}
              disabled={cloud.loading}
            >
              {cloud.loading ? "Testing..." : "Test Connection"}
            </button>
            {cloud.connected && (
              <button
                className="cloud-action-btn cloud-action-btn-secondary"
                onClick={() => cloud.logout()}
              >
                Disconnect
              </button>
            )}
          </div>

          {/* Error */}
          {cloud.error && (
            <div className="settings-error">{cloud.error}</div>
          )}
        </div>
      )}
    </div>
  );
}
