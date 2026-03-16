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

// ---------------------------------------------------------------------------
// Workflow Types
// ---------------------------------------------------------------------------

export interface CloudWorkflowNode {
  id: string;
  node_type: "trigger" | "source" | "executor" | "sink";
  kind: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
  label: string;
}

export interface CloudWorkflowEdge {
  id: string;
  source: string;
  target: string;
}

export interface CloudWorkflow {
  org: string;
  username: string;
  workflow_id: string;
  name: string;
  description: string;
  enabled: boolean;
  timezone: string;
  nodes: CloudWorkflowNode[];
  edges: CloudWorkflowEdge[];
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CloudWorkflowNodeRun {
  node_id: string;
  status: "running" | "success" | "failed";
  started_at: string;
  finished_at: string | null;
  output_preview: string | null;
}

export interface CloudWorkflowRun {
  org: string;
  workflow_id: string;
  run_id: string;
  status: "running" | "success" | "failed";
  trigger: string;
  started_at: string;
  finished_at: string | null;
  node_runs: CloudWorkflowNodeRun[];
  error: string | null;
}

// ---------------------------------------------------------------------------
// Workflow API calls
// ---------------------------------------------------------------------------

/** List all cloud workflows for the current org. */
export async function cloudListWorkflows(cloudUrl: string): Promise<CloudWorkflow[]> {
  log("http", "invoke cloud_list_workflows");
  const data = await invoke<{ workflows: CloudWorkflow[] }>("cloud_list_workflows", { cloudUrl });
  return data.workflows ?? (data as unknown as CloudWorkflow[]);
}

/** Get a single cloud workflow by ID. */
export async function cloudGetWorkflow(
  cloudUrl: string,
  workflowId: string
): Promise<CloudWorkflow> {
  log("http", `invoke cloud_get_workflow id=${workflowId}`);
  return invoke<CloudWorkflow>("cloud_get_workflow", { cloudUrl, workflowId });
}

/** Create a new cloud workflow. */
export async function cloudCreateWorkflow(
  cloudUrl: string,
  workflow: Partial<CloudWorkflow>
): Promise<CloudWorkflow> {
  log("http", `invoke cloud_create_workflow name=${workflow.name}`);
  return invoke<CloudWorkflow>("cloud_create_workflow", { cloudUrl, workflow });
}

/** Update an existing cloud workflow. */
export async function cloudUpdateWorkflow(
  cloudUrl: string,
  workflowId: string,
  updates: Partial<CloudWorkflow>
): Promise<CloudWorkflow> {
  log("http", `invoke cloud_update_workflow id=${workflowId}`);
  return invoke<CloudWorkflow>("cloud_update_workflow", { cloudUrl, workflowId, updates });
}

/** Delete a cloud workflow. */
export async function cloudDeleteWorkflow(
  cloudUrl: string,
  workflowId: string
): Promise<{ ok: boolean }> {
  log("http", `invoke cloud_delete_workflow id=${workflowId}`);
  return invoke<{ ok: boolean }>("cloud_delete_workflow", { cloudUrl, workflowId });
}

/** Manually trigger a cloud workflow run. */
export async function cloudTriggerWorkflow(
  cloudUrl: string,
  workflowId: string
): Promise<CloudWorkflowRun> {
  log("http", `invoke cloud_trigger_workflow id=${workflowId}`);
  return invoke<CloudWorkflowRun>("cloud_trigger_workflow", { cloudUrl, workflowId });
}

/** Enable or disable a cloud workflow. */
export async function cloudEnableWorkflow(
  cloudUrl: string,
  workflowId: string,
  enabled: boolean
): Promise<CloudWorkflow> {
  log("http", `invoke cloud_enable_workflow id=${workflowId} enabled=${enabled}`);
  return invoke<CloudWorkflow>("cloud_enable_workflow", { cloudUrl, workflowId, enabled });
}

/** List runs for a cloud workflow. */
export async function cloudListWorkflowRuns(
  cloudUrl: string,
  workflowId: string
): Promise<CloudWorkflowRun[]> {
  log("http", `invoke cloud_list_workflow_runs id=${workflowId}`);
  const data = await invoke<{ runs: CloudWorkflowRun[] }>("cloud_list_workflow_runs", {
    cloudUrl,
    workflowId,
  });
  return data.runs ?? (data as unknown as CloudWorkflowRun[]);
}

/** Get a single run detail for a cloud workflow. */
export async function cloudGetWorkflowRun(
  cloudUrl: string,
  workflowId: string,
  runId: string
): Promise<CloudWorkflowRun> {
  log("http", `invoke cloud_get_workflow_run wf=${workflowId} run=${runId}`);
  return invoke<CloudWorkflowRun>("cloud_get_workflow_run", { cloudUrl, workflowId, runId });
}
