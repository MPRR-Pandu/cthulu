import type { Flow, FlowNode, FlowEdge } from "../types/flow";
import type { UpdateSignal, UpdateSource } from "../hooks/useFlowDispatch";

export function makeFlowNode(overrides: Partial<FlowNode> = {}): FlowNode {
  return {
    id: "node-1",
    node_type: "trigger",
    kind: "manual",
    config: {},
    position: { x: 0, y: 0 },
    label: "Trigger",
    ...overrides,
  };
}

export function makeFlowEdge(overrides: Partial<FlowEdge> = {}): FlowEdge {
  return {
    id: "edge-1",
    source: "node-1",
    target: "node-2",
    ...overrides,
  };
}

export function makeFlow(overrides: Partial<Flow> = {}): Flow {
  const triggerNode = makeFlowNode({ id: "node-1", node_type: "trigger", kind: "manual", label: "Trigger" });
  const executorNode = makeFlowNode({ id: "node-2", node_type: "executor", kind: "claude-code", label: "Executor", position: { x: 300, y: 0 } });
  const edge = makeFlowEdge({ id: "edge-1", source: "node-1", target: "node-2" });

  return {
    id: "flow-1",
    name: "Test Flow",
    description: "A test flow",
    enabled: true,
    nodes: [triggerNode, executorNode],
    edges: [edge],
    version: 1,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

export function makeSignal(counter: number, source: UpdateSource): UpdateSignal {
  return { counter, source };
}
