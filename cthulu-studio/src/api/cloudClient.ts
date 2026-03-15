/**
 * Cloud API client — all cthulu-cloud REST API calls via Tauri invoke.
 *
 * These invoke commands are implemented in cloud_api.rs (Rust side).
 * Each call reads cloud_url and cloud_jwt from secrets.json on the Rust side.
 */
import { invoke } from "@tauri-apps/api/core";
import { log } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CloudLoginResponse {
  token: string;
  user: string;
  org: string;
}

export interface CloudAgent {
  name: string;
  system_prompt: string;
  tools: string[];
  model: string;
  created_at: string;
  updated_at: string;
}

export interface CloudTask {
  id: string;
  agent_name: string;
  message: string;
  state: "queued" | "running" | "completed" | "failed";
  result: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// API calls (routed through Tauri invoke → cloud_api.rs → cthulu-cloud REST)
// ---------------------------------------------------------------------------

/**
 * Login to cthulu-cloud using credentials already stored in secrets.json.
 * The Rust side reads github_pat and anthropic_api_key from secrets.json,
 * posts to the cloud's /api/auth/login, and stores the returned JWT.
 */
export async function cloudLogin(cloudUrl: string): Promise<CloudLoginResponse> {
  log("http", `invoke cloud_login url=${cloudUrl}`);
  return invoke<CloudLoginResponse>("cloud_login", { cloudUrl });
}

/** List all agents registered in the cloud for the current org. */
export async function cloudListAgents(cloudUrl: string): Promise<CloudAgent[]> {
  log("http", "invoke cloud_list_agents");
  const data = await invoke<{ agents: CloudAgent[] }>("cloud_list_agents", { cloudUrl });
  return data.agents;
}

/** Sync a local agent definition to the cloud. */
export async function cloudSyncAgent(
  cloudUrl: string,
  agent: { name: string; system_prompt: string; tools: string[]; model: string }
): Promise<{ ok: boolean }> {
  log("http", `invoke cloud_sync_agent name=${agent.name}`);
  return invoke<{ ok: boolean }>("cloud_sync_agent", { cloudUrl, agent });
}

/** Submit a task (message) to a cloud agent. */
export async function cloudSubmitTask(
  cloudUrl: string,
  agentName: string,
  message: string
): Promise<CloudTask> {
  log("http", `invoke cloud_submit_task agent=${agentName}`);
  return invoke<CloudTask>("cloud_submit_task", { cloudUrl, agentName, message });
}

/** List all tasks for the current org. */
export async function cloudListTasks(cloudUrl: string): Promise<CloudTask[]> {
  log("http", "invoke cloud_list_tasks");
  const data = await invoke<{ tasks: CloudTask[] }>("cloud_list_tasks", { cloudUrl });
  return data.tasks;
}

/** Get a single task by ID. */
export async function cloudGetTask(cloudUrl: string, taskId: string): Promise<CloudTask> {
  log("http", `invoke cloud_get_task id=${taskId}`);
  return invoke<CloudTask>("cloud_get_task", { cloudUrl, taskId });
}

/** Simple chat message to a cloud agent — submits task and polls for result. */
export async function cloudChatMessage(
  cloudUrl: string,
  agentName: string,
  message: string
): Promise<CloudTask> {
  log("http", `invoke cloud_chat_message agent=${agentName}`);
  // For now, chat is just a task submission. The caller can poll for completion.
  return cloudSubmitTask(cloudUrl, agentName, message);
}
