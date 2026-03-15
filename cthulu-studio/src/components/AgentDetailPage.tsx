import { useState, useEffect, useCallback, useRef } from "react";
import * as api from "../api/client";
import type { Agent, AgentSummary } from "../types/flow";
import { STUDIO_ASSISTANT_ID } from "../types/flow";
import { StatusBadge } from "./StatusBadge";
import { AgentDashboard } from "./AgentDashboard";
import { AgentConfigPage } from "./AgentConfigPage";
import { AgentRunsTab } from "./AgentRunsTab";
import { TaskList } from "./TaskList";
import { deriveAgentStatus } from "../lib/status-colors";
import { LayoutDashboard, Settings, Play, ClipboardList, Cloud, RefreshCw, Send, ChevronDown, ChevronRight, Check, Loader2 } from "lucide-react";
import { useCloud } from "../contexts/CloudContext";
import type { CloudTask } from "../api/cloudClient";

type DetailTab = "dashboard" | "configuration" | "runs" | "tasks";

interface AgentDetailPageProps {
  agentId: string;
  sessionId: string;
  onBack: () => void;
  onDeleted: () => void;
}

// Helper: relative time from ISO timestamp
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

// Chat message pair for cloud chat
interface ChatPair {
  id: string;
  userMessage: string;
  task: CloudTask | null;
  loading: boolean;
  error: string | null;
}

export function AgentDetailPage({ agentId, sessionId, onBack, onDeleted }: AgentDetailPageProps) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [tab, setTab] = useState<DetailTab>("dashboard");
  const [sessionBusy, setSessionBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Cloud features state
  const cloud = useCloud();
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "synced" | "error">("idle");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [cloudTasksOpen, setCloudTasksOpen] = useState(true);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [chatInput, setChatInput] = useState("");
  const [chatPairs, setChatPairs] = useState<ChatPair[]>([]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  // Load agent
  const loadAgent = useCallback(() => {
    api.getAgent(agentId).then(setAgent).catch(() => {});
  }, [agentId]);

  useEffect(() => { loadAgent(); }, [loadAgent]);

  // Load agents list (for Tasks tab)
  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => {});
  }, []);

  // Poll session status
  useEffect(() => {
    const poll = () => {
      api.listAgentSessions(agentId).then(res => {
        const sessions = res.sessions ?? [];
        setSessionBusy(sessions.some((s: any) => s.busy));
      }).catch(() => {});
    };
    poll();
    const iv = setInterval(poll, 5000);
    return () => clearInterval(iv);
  }, [agentId]);

  const handleTriggerHeartbeat = useCallback(async () => {
    try { await api.wakeupAgent(agentId); } catch (e) { console.error(e); }
  }, [agentId]);

  const handleDelete = useCallback(async () => {
    if (!confirm(`Delete agent "${agent?.name}"?`)) return;
    try {
      await api.deleteAgent(agentId);
      onDeleted();
    } catch (e) { console.error(e); }
  }, [agentId, agent?.name, onDeleted]);

  // --- Cloud: Sync to Cloud ---
  const handleSyncToCloud = useCallback(async () => {
    if (!agent) return;
    setSyncStatus("syncing");
    setSyncError(null);
    try {
      await cloud.syncAgent({
        name: agent.name,
        system_prompt: agent.prompt || "",
        tools: [],
        model: "claude-sonnet-4-20250514",
      });
      setSyncStatus("synced");
      setTimeout(() => setSyncStatus("idle"), 2000);
    } catch (e) {
      setSyncStatus("error");
      setSyncError(e instanceof Error ? e.message : String(e));
      setTimeout(() => setSyncStatus("idle"), 3000);
    }
  }, [agent, cloud]);

  // --- Cloud: Toggle expanded task ---
  const toggleTaskExpanded = useCallback((taskId: string) => {
    setExpandedTasks(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  // --- Cloud: Filter tasks for this agent ---
  const agentCloudTasks = cloud.tasks.filter(t => t.agent_name === agent?.name);

  // --- Cloud Chat: Submit ---
  const handleChatSubmit = useCallback(async () => {
    if (!chatInput.trim() || !agent) return;
    const message = chatInput.trim();
    const pairId = `chat-${Date.now()}`;
    setChatInput("");
    setChatPairs(prev => [...prev, { id: pairId, userMessage: message, task: null, loading: true, error: null }]);
    try {
      const task = await cloud.submitTask(agent.name, message);
      setChatPairs(prev => prev.map(p => p.id === pairId ? { ...p, task, loading: false } : p));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setChatPairs(prev => prev.map(p => p.id === pairId ? { ...p, loading: false, error: errMsg } : p));
    }
  }, [chatInput, agent, cloud]);

  if (!agent) {
    return <div className="agent-detail-loading">Loading...</div>;
  }

  const status = deriveAgentStatus(agent.heartbeat_enabled, sessionBusy, false);
  const isStudioAssistant = agent.id === STUDIO_ASSISTANT_ID;

  return (
    <div className="agent-detail-page">
      {/* Header */}
      <div className="agent-detail-page-header">
        <button className="agent-detail-back" onClick={onBack}>
          ← Back
        </button>
        <div className="agent-detail-identity">
          <h2 className="agent-detail-name">{agent.name}</h2>
          {agent.description && (
            <p className="agent-detail-desc">{agent.description}</p>
          )}
        </div>
        <div className="agent-detail-header-actions">
          <button className="agent-detail-action-btn" onClick={handleTriggerHeartbeat} title="Trigger heartbeat run">
            ▶ Run Heartbeat
          </button>
          {cloud.connected && (
            <button
              className={`cloud-sync-btn${syncStatus === "synced" ? " synced" : ""}`}
              onClick={handleSyncToCloud}
              disabled={syncStatus === "syncing"}
              title={syncError || "Sync agent to cloud"}
            >
              {syncStatus === "syncing" && <Loader2 className="cloud-sync-btn-icon spinning" size={14} />}
              {syncStatus === "synced" && <Check className="cloud-sync-btn-icon" size={14} />}
              {syncStatus === "idle" && <Cloud className="cloud-sync-btn-icon" size={14} />}
              {syncStatus === "error" && <Cloud className="cloud-sync-btn-icon" size={14} />}
              {syncStatus === "syncing" ? "Syncing…" : syncStatus === "synced" ? "Synced" : syncStatus === "error" ? "Error" : "Sync to Cloud"}
            </button>
          )}
          <StatusBadge status={status} />
          {sessionBusy && (
            <span className="live-indicator">
              <span className="live-indicator-dot" />
              Live
            </span>
          )}
          {!isStudioAssistant && (
            <div className="agent-detail-overflow" ref={menuRef}>
              <button className="agent-detail-overflow-btn" onClick={() => setMenuOpen(!menuOpen)}>
                ⋯
              </button>
              {menuOpen && (
                <div className="agent-detail-overflow-menu">
                  <button onClick={() => { navigator.clipboard.writeText(agent.id); setMenuOpen(false); }}>
                    Copy Agent ID
                  </button>
                  <button className="agent-detail-overflow-danger" onClick={() => { handleDelete(); setMenuOpen(false); }}>
                    Delete Agent
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tab Bar */}
      <div className="agent-detail-tab-bar">
        {([
          { id: "dashboard" as DetailTab, label: "Dashboard", icon: LayoutDashboard },
          { id: "configuration" as DetailTab, label: "Configuration", icon: Settings },
          { id: "runs" as DetailTab, label: "Runs", icon: Play },
          { id: "tasks" as DetailTab, label: "Tasks", icon: ClipboardList },
        ]).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`agent-detail-tab${tab === id ? " agent-detail-tab-active" : ""}`}
            onClick={() => setTab(id)}
          >
            <Icon className="agent-detail-tab-icon" />
            {label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="agent-detail-tab-content">
        {tab === "dashboard" && <AgentDashboard agent={agent} sessionId={sessionId} />}
        {tab === "configuration" && <AgentConfigPage agent={agent} onAgentUpdated={loadAgent} />}
        {tab === "runs" && <AgentRunsTab agentId={agentId} />}
        {tab === "tasks" && <TaskList agentId={agentId} agents={agents} />}
      </div>

      {/* Cloud Tasks Section */}
      {cloud.connected && (
        <div className="cloud-tasks-section">
          <div className="cloud-tasks-header" onClick={() => setCloudTasksOpen(!cloudTasksOpen)}>
            {cloudTasksOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="cloud-tasks-title">Cloud Tasks</span>
            <span className="cloud-tasks-count">{agentCloudTasks.length}</span>
            <button
              className="cloud-tasks-refresh"
              onClick={(e) => { e.stopPropagation(); cloud.refreshTasks(); }}
              title="Refresh cloud tasks"
            >
              <RefreshCw size={12} />
            </button>
          </div>
          {cloudTasksOpen && (
            <div className="cloud-tasks-body">
              {agentCloudTasks.length === 0 ? (
                <div className="cloud-tasks-empty">No cloud tasks yet</div>
              ) : (
                agentCloudTasks.map(task => (
                  <div key={task.id}>
                    <div className="cloud-task-row" onClick={() => toggleTaskExpanded(task.id)}>
                      <span className={`cloud-task-state ${task.state}`}>{task.state}</span>
                      <span className="cloud-task-time">{timeAgo(task.created_at)}</span>
                      <span className="cloud-task-result-preview">
                        {task.result ? task.result.slice(0, 100) + (task.result.length > 100 ? "…" : "") : "—"}
                      </span>
                    </div>
                    {expandedTasks.has(task.id) && (
                      <div className="cloud-task-expanded">
                        <div className="cloud-task-expanded-label">Message:</div>
                        <div className="cloud-task-expanded-text">{task.message}</div>
                        <div className="cloud-task-expanded-label">Result:</div>
                        <div className="cloud-task-expanded-text">{task.result || "No result yet"}</div>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* Cloud Chat Section */}
      {cloud.connected && (
        <div className="cloud-chat-section">
          <div className="cloud-chat-title">Cloud Chat</div>
          <div className="cloud-chat-messages">
            {chatPairs.length === 0 && (
              <div className="cloud-chat-empty">Send a message to this agent via the cloud.</div>
            )}
            {chatPairs.map(pair => (
              <div key={pair.id} className="cloud-chat-message">
                <div className="cloud-chat-user">{pair.userMessage}</div>
                <div className="cloud-chat-response">
                  {pair.loading && <Loader2 className="spinning" size={14} />}
                  {pair.error && <span className="cloud-chat-error">{pair.error}</span>}
                  {pair.task && !pair.loading && (
                    <span>
                      <span className={`cloud-task-state ${pair.task.state}`}>{pair.task.state}</span>
                      {" "}
                      {pair.task.result || "Awaiting result…"}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="cloud-chat-input">
            <input
              type="text"
              placeholder="Send a message to the cloud agent…"
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleChatSubmit(); } }}
            />
            <button onClick={handleChatSubmit} disabled={!chatInput.trim()} title="Send">
              <Send size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
