import { useCallback, useRef } from "react";
import type { RefObject } from "react";
import type { CanvasHandle } from "../components/Canvas";
import type { FlowNode, FlowEdge } from "../types/flow";
import { layoutNodes, generatePipelineEdges } from "../lib/flowLayout";

// Command types the agent can emit in JSON code blocks
interface CreateFlowCommand {
  action: "create_flow";
  name: string;
  description?: string;
  nodes: Array<{
    node_type: string;
    kind: string;
    label: string;
    config: Record<string, unknown>;
  }>;
  edges: "auto" | Array<{ source: string; target: string }>;
}

interface AddNodeCommand {
  action: "add_node";
  node_type: string;
  kind: string;
  label: string;
  config: Record<string, unknown>;
}

interface UpdateNodeCommand {
  action: "update_node";
  label: string;
  config: Record<string, unknown>;
}

interface DeleteNodeCommand {
  action: "delete_node";
  label: string;
}

interface PreviewCommand {
  action: "preview";
}

type WorkflowCommand =
  | CreateFlowCommand
  | AddNodeCommand
  | UpdateNodeCommand
  | DeleteNodeCommand
  | PreviewCommand;

export interface CommandResult {
  success: boolean;
  message: string;
  nodesAdded?: number;
  edgesAdded?: number;
}

/**
 * Extract JSON code blocks from markdown text.
 * Looks for ```json ... ``` blocks and parses them.
 */
function extractJsonBlocks(text: string): unknown[] {
  const regex = /```json\s*\n([\s\S]*?)```/g;
  const blocks: unknown[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      blocks.push(JSON.parse(match[1]));
    } catch {
      // Skip malformed JSON
    }
  }
  return blocks;
}

/**
 * Check if a parsed JSON block is a workflow command.
 */
function isWorkflowCommand(obj: unknown): obj is WorkflowCommand {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "action" in obj &&
    typeof (obj as Record<string, unknown>).action === "string" &&
    ["create_flow", "add_node", "update_node", "delete_node", "preview"].includes(
      (obj as Record<string, unknown>).action as string,
    )
  );
}

export function useWorkflowCommands(
  canvasRef: RefObject<CanvasHandle | null>,
  onFlowMetaChange?: (name: string, description: string) => void,
) {
  const lastResultRef = useRef<CommandResult | null>(null);

  const executeCommand = useCallback(
    (cmd: WorkflowCommand): CommandResult => {
      const canvas = canvasRef.current;
      if (!canvas && cmd.action !== "preview") {
        return { success: false, message: "Canvas not ready" };
      }

      switch (cmd.action) {
        case "create_flow": {
          // Convert command nodes to FlowNodes
          const flowNodes: FlowNode[] = cmd.nodes.map((n) => ({
            id: crypto.randomUUID(),
            node_type: n.node_type as FlowNode["node_type"],
            kind: n.kind,
            label: n.label,
            config: n.config as Record<string, unknown>,
            position: { x: 0, y: 0 }, // will be set by layout
          }));

          // Apply auto-layout
          const laidOut = layoutNodes(flowNodes);

          // Generate edges
          let flowEdges: FlowEdge[];
          if (cmd.edges === "auto") {
            flowEdges = generatePipelineEdges(laidOut).map((e) => ({
              id: e.id,
              source: e.source,
              target: e.target,
            }));
          } else {
            // Resolve label-based edges to ID-based
            flowEdges = cmd.edges
              .map((e) => {
                const srcNode = laidOut.find((n) => n.label === e.source);
                const tgtNode = laidOut.find((n) => n.label === e.target);
                return {
                  id: crypto.randomUUID(),
                  source: srcNode?.id ?? "",
                  target: tgtNode?.id ?? "",
                };
              })
              .filter((e) => e.source && e.target);
          }

          // Apply to canvas via spread-merge
          canvas!.mergeFromFlow(laidOut, flowEdges);

          // Update flow metadata
          if (onFlowMetaChange && cmd.name) {
            onFlowMetaChange(cmd.name, cmd.description ?? "");
          }

          return {
            success: true,
            message: `Created flow "${cmd.name}" with ${laidOut.length} nodes and ${flowEdges.length} edges`,
            nodesAdded: laidOut.length,
            edgesAdded: flowEdges.length,
          };
        }

        case "add_node": {
          // Add a single node at a reasonable position
          const node = canvas!.addNodeAtScreen(cmd.node_type, cmd.kind, cmd.label, 400, 300);
          if (node) {
            // Update config via spread-merge
            canvas!.updateNodeData(node.id, { config: cmd.config as Record<string, unknown> });
            return { success: true, message: `Added node "${cmd.label}"`, nodesAdded: 1 };
          }
          return { success: false, message: `Failed to add node "${cmd.label}"` };
        }

        case "update_node": {
          return {
            success: false,
            message: "update_node: not yet implemented (use create_flow instead)",
          };
        }

        case "delete_node": {
          return { success: false, message: "delete_node: not yet implemented" };
        }

        case "preview": {
          return { success: true, message: "Preview requested (no canvas changes)" };
        }
      }
    },
    [canvasRef, onFlowMetaChange],
  );

  /**
   * Process an assistant message, looking for JSON workflow commands.
   * Returns results for any commands found and executed.
   */
  const processAgentMessage = useCallback(
    (text: string): CommandResult[] => {
      const blocks = extractJsonBlocks(text);
      const results: CommandResult[] = [];

      for (const block of blocks) {
        if (isWorkflowCommand(block)) {
          const result = executeCommand(block);
          results.push(result);
          lastResultRef.current = result;
        }
      }

      return results;
    },
    [executeCommand],
  );

  return { processAgentMessage, lastResult: lastResultRef };
}
