import { useState, useEffect, useCallback } from "react";
import {
  checkSetupStatus,
  saveGithubPat,
  saveAnthropicKey,
  saveOpenaiKey,
  saveSlackWebhook,
} from "../../api/client";

interface CredentialDef {
  key: string;
  label: string;
  statusField: string;
  placeholder: string;
  save: (value: string) => Promise<{ ok: boolean }>;
}

const CREDENTIALS: CredentialDef[] = [
  {
    key: "github_pat",
    label: "GitHub Personal Access Token",
    statusField: "github_pat_configured",
    placeholder: "ghp_...",
    save: async (v) => {
      const res = await saveGithubPat(v);
      return { ok: res.ok };
    },
  },
  {
    key: "anthropic_key",
    label: "Anthropic API Key",
    statusField: "anthropic_api_key_configured",
    placeholder: "sk-ant-...",
    save: saveAnthropicKey,
  },
  {
    key: "openai_key",
    label: "OpenAI API Key",
    statusField: "openai_api_key_configured",
    placeholder: "sk-...",
    save: saveOpenaiKey,
  },
  {
    key: "slack_webhook",
    label: "Slack Webhook URL",
    statusField: "slack_webhook_configured",
    placeholder: "https://hooks.slack.com/...",
    save: saveSlackWebhook,
  },
];

export default function CredentialsSection() {
  const [statuses, setStatuses] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    checkSetupStatus()
      .then((status) => {
        if (cancelled) return;
        const map: Record<string, boolean> = {};
        for (const cred of CREDENTIALS) {
          map[cred.key] = (status as Record<string, unknown>)[cred.statusField] === true;
        }
        setStatuses(map);
      })
      .catch(() => {
        // Setup status unavailable
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = useCallback(
    async (cred: CredentialDef) => {
      if (!editValue.trim()) return;
      setSaving(true);
      setError(null);
      try {
        const res = await cred.save(editValue.trim());
        if (res.ok) {
          setStatuses((prev) => ({ ...prev, [cred.key]: true }));
          setEditing(null);
          setEditValue("");
        } else {
          setError("Save failed");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Save failed");
      } finally {
        setSaving(false);
      }
    },
    [editValue],
  );

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span className="settings-section-title">Credentials</span>
      </div>
      <div className="settings-section-body">
        {CREDENTIALS.map((cred) => (
          <div key={cred.key} className="credential-row">
            <div className="credential-info">
              <span className="credential-name">{cred.label}</span>
              <span
                className={`credential-status ${statuses[cred.key] ? "configured" : "not-configured"}`}
              >
                {statuses[cred.key] ? "Configured" : "Not configured"}
              </span>
            </div>
            {editing === cred.key ? (
              <div className="credential-edit">
                <input
                  className="settings-input"
                  type="password"
                  placeholder={cred.placeholder}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSave(cred);
                    if (e.key === "Escape") {
                      setEditing(null);
                      setEditValue("");
                      setError(null);
                    }
                  }}
                  autoFocus
                />
                <button
                  className="credential-save-btn"
                  onClick={() => handleSave(cred)}
                  disabled={saving || !editValue.trim()}
                >
                  {saving ? "Saving..." : "Save"}
                </button>
                <button
                  className="credential-cancel-btn"
                  onClick={() => {
                    setEditing(null);
                    setEditValue("");
                    setError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="credential-edit-btn"
                onClick={() => {
                  setEditing(cred.key);
                  setEditValue("");
                  setError(null);
                }}
              >
                Edit
              </button>
            )}
          </div>
        ))}
        {error && <div className="settings-error">{error}</div>}
      </div>
    </div>
  );
}
