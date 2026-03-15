import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import {
  getCloudConfig,
  saveCloudConfig,
  checkSetupStatus,
  getTokenStatus,
} from "../api/client";
import {
  cloudLogin,
  cloudListAgents,
  cloudListTasks,
  cloudSyncAgent,
  cloudSubmitTask,
  type CloudAgent,
  type CloudTask,
} from "../api/cloudClient";

// ---------------------------------------------------------------------------
// Context value interface
// ---------------------------------------------------------------------------

interface CloudContextValue {
  // Core state
  enabled: boolean;
  cloudUrl: string;
  connected: boolean;
  jwt: string;
  org: string;
  agents: CloudAgent[];
  tasks: CloudTask[];
  loading: boolean;
  error: string | null;

  // Connection status indicators
  cloudApiOk: boolean;
  githubPatOk: boolean;
  claudeCliOk: boolean;

  // Actions
  setEnabled: (enabled: boolean) => void;
  setCloudUrl: (url: string) => void;
  testConnection: () => Promise<void>;
  logout: () => void;
  refreshAgents: () => Promise<void>;
  refreshTasks: () => Promise<void>;
  syncAgent: (agent: {
    name: string;
    system_prompt: string;
    tools: string[];
    model: string;
  }) => Promise<{ ok: boolean }>;
  submitTask: (agentName: string, message: string) => Promise<CloudTask>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const CloudContext = createContext<CloudContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function CloudProvider({ children }: { children: ReactNode }) {
  // Core state
  const [enabled, setEnabledState] = useState(false);
  const [cloudUrl, setCloudUrlState] = useState("http://localhost:8080");
  const [connected, setConnected] = useState(false);
  const [jwt, setJwt] = useState("");
  const [org, setOrg] = useState("");
  const [agents, setAgents] = useState<CloudAgent[]>([]);
  const [tasks, setTasks] = useState<CloudTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Connection status indicators
  const [cloudApiOk, setCloudApiOk] = useState(false);
  const [githubPatOk, setGithubPatOk] = useState(false);
  const [claudeCliOk, setClaudeCliOk] = useState(false);

  // --- Internal helpers (no useCallback — these are only called from actions) ---

  const connect = useCallback(async (url: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await cloudLogin(url);
      setJwt(res.token);
      setOrg(res.org);
      setConnected(true);
      setCloudApiOk(true);

      // Refresh agents and tasks after successful login
      try {
        const agentsList = await cloudListAgents(url);
        setAgents(agentsList);
      } catch {
        // Non-fatal: agents list may fail independently
      }
      try {
        const tasksList = await cloudListTasks(url);
        setTasks(tasksList);
      } catch {
        // Non-fatal: tasks list may fail independently
      }
    } catch (e) {
      setConnected(false);
      setCloudApiOk(false);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // --- Init on mount: load persisted config ---
  useEffect(() => {
    let cancelled = false;
    getCloudConfig()
      .then((cfg) => {
        if (cancelled) return;
        setCloudUrlState(cfg.cloud_url || "http://localhost:8080");
        setEnabledState(cfg.cloud_enabled);
        if (cfg.cloud_jwt) {
          setJwt(cfg.cloud_jwt);
        }
        // Auto-connect if enabled
        if (cfg.cloud_enabled) {
          connect(cfg.cloud_url || "http://localhost:8080");
        }
      })
      .catch(() => {
        // Config not available — stay with defaults
      });
    return () => {
      cancelled = true;
    };
  }, [connect]);

  // --- Actions ---

  const setEnabled = useCallback(
    (value: boolean) => {
      setEnabledState(value);
      if (value) {
        // Toggling ON: persist and auto-connect
        saveCloudConfig(cloudUrl, true).catch(() => {});
        connect(cloudUrl);
      } else {
        // Toggling OFF: clear state and persist
        saveCloudConfig(cloudUrl, false).catch(() => {});
        setConnected(false);
        setJwt("");
        setOrg("");
        setAgents([]);
        setTasks([]);
        setCloudApiOk(false);
        setError(null);
      }
    },
    [cloudUrl, connect],
  );

  const setCloudUrl = useCallback(
    (url: string) => {
      setCloudUrlState(url);
      saveCloudConfig(url, enabled).catch(() => {});
      if (enabled) {
        connect(url);
      }
    },
    [enabled, connect],
  );

  const testConnection = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Test cloud API — try listing agents (lightweight check)
      try {
        await cloudListAgents(cloudUrl);
        setCloudApiOk(true);
      } catch {
        setCloudApiOk(false);
      }

      // Test GitHub PAT
      try {
        const setupStatus = await checkSetupStatus();
        setGithubPatOk(setupStatus.github_pat_configured);
      } catch {
        setGithubPatOk(false);
      }

      // Test Claude CLI token
      try {
        const tokenStatus = await getTokenStatus();
        setClaudeCliOk(tokenStatus.has_token);
      } catch {
        setClaudeCliOk(false);
      }
    } finally {
      setLoading(false);
    }
  }, [cloudUrl]);

  const logout = useCallback(() => {
    setJwt("");
    setConnected(false);
    setCloudApiOk(false);
    setOrg("");
    setAgents([]);
    setTasks([]);
  }, []);

  const refreshAgents = useCallback(async () => {
    try {
      const agentsList = await cloudListAgents(cloudUrl);
      setAgents(agentsList);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [cloudUrl]);

  const refreshTasks = useCallback(async () => {
    try {
      const tasksList = await cloudListTasks(cloudUrl);
      setTasks(tasksList);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [cloudUrl]);

  const syncAgentAction = useCallback(
    async (agent: {
      name: string;
      system_prompt: string;
      tools: string[];
      model: string;
    }) => {
      return cloudSyncAgent(cloudUrl, agent);
    },
    [cloudUrl],
  );

  const submitTaskAction = useCallback(
    async (agentName: string, message: string) => {
      return cloudSubmitTask(cloudUrl, agentName, message);
    },
    [cloudUrl],
  );

  return (
    <CloudContext.Provider
      value={{
        enabled,
        cloudUrl,
        connected,
        jwt,
        org,
        agents,
        tasks,
        loading,
        error,
        cloudApiOk,
        githubPatOk,
        claudeCliOk,
        setEnabled,
        setCloudUrl,
        testConnection,
        logout,
        refreshAgents,
        refreshTasks,
        syncAgent: syncAgentAction,
        submitTask: submitTaskAction,
      }}
    >
      {children}
    </CloudContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCloud(): CloudContextValue {
  const ctx = useContext(CloudContext);
  if (!ctx) throw new Error("useCloud must be used within CloudProvider");
  return ctx;
}
