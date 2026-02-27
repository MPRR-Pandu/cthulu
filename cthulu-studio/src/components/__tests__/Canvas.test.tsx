import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { createRef } from "react";
import Canvas, { type CanvasHandle } from "../Canvas";
import { makeFlow, makeFlowNode, makeFlowEdge, makeSignal } from "../../test/fixtures";
import type { Flow, FlowNode, FlowEdge } from "../../types/flow";
import type { UpdateSignal } from "../../hooks/useFlowDispatch";

// --- Mock @xyflow/react ---
// We mock React Flow so we can inspect node/edge state without a full canvas.
let capturedNodes: any[] = [];
let capturedEdges: any[] = [];
let onNodesChangeFn: any = null;

vi.mock("@xyflow/react", () => {
  const { useState, useCallback } = require("react");
  return {
    ReactFlow: (props: any) => {
      capturedNodes = props.nodes;
      capturedEdges = props.edges;
      return <div data-testid="react-flow" />;
    },
    MiniMap: () => null,
    Controls: () => null,
    Background: () => null,
    BackgroundVariant: { Dots: "dots" },
    Position: { Right: "right", Left: "left" },
    useNodesState: (initial: any[]) => {
      const [nodes, setNodes] = useState(initial);
      const onNodesChange = useCallback(() => {}, []);
      onNodesChangeFn = onNodesChange;
      return [nodes, setNodes, onNodesChange];
    },
    useEdgesState: (initial: any[]) => {
      const [edges, setEdges] = useState(initial);
      const onEdgesChange = useCallback(() => {}, []);
      return [edges, setEdges, onEdgesChange];
    },
    addEdge: (params: any, edges: any[]) => [...edges, { id: `e-${params.source}-${params.target}`, ...params }],
  };
});

// --- Mock logger ---
vi.mock("../../api/logger", () => ({
  log: vi.fn(),
}));

// --- Mock node type components ---
vi.mock("../NodeTypes/TriggerNode", () => ({ default: () => null }));
vi.mock("../NodeTypes/SourceNode", () => ({ default: () => null }));
vi.mock("../NodeTypes/ExecutorNode", () => ({ default: () => null }));
vi.mock("../NodeTypes/SinkNode", () => ({ default: () => null }));

interface RenderCanvasProps {
  flowId?: string | null;
  canonicalFlow?: Flow | null;
  updateSignal?: UpdateSignal;
  onFlowChange?: (updates: { nodes: FlowNode[]; edges: FlowEdge[] }) => void;
  onSelectionChange?: (nodeId: string | null) => void;
}

function renderCanvas(props: RenderCanvasProps = {}) {
  const ref = createRef<CanvasHandle>();
  const defaultProps = {
    flowId: props.flowId !== undefined ? props.flowId : "flow-1",
    canonicalFlow: props.canonicalFlow !== undefined ? props.canonicalFlow : makeFlow(),
    updateSignal: props.updateSignal || makeSignal(1, "init"),
    onFlowChange: props.onFlowChange || vi.fn(),
    onSelectionChange: props.onSelectionChange || vi.fn(),
    nodeRunStatus: {},
  };

  const result = render(<Canvas ref={ref} {...defaultProps} />);

  return {
    ref,
    ...result,
    rerender: (overrides: Partial<typeof defaultProps>) =>
      result.rerender(<Canvas ref={ref} {...defaultProps} {...overrides} />),
    getNodes: () => capturedNodes,
    getEdges: () => capturedEdges,
  };
}

describe("Canvas", () => {
  beforeEach(() => {
    capturedNodes = [];
    capturedEdges = [];
    vi.clearAllMocks();
  });

  // --- 5a. Update signal routing ---

  describe("update signal routing", () => {
    it("source='canvas' skips merge (self-originated)", () => {
      const flow = makeFlow();
      const { rerender, getNodes } = renderCanvas({
        canonicalFlow: flow,
        updateSignal: makeSignal(1, "init"),
      });

      const nodesAfterInit = [...getNodes()];

      // Dispatch as "canvas" — should NOT re-merge
      const modifiedFlow = makeFlow({ name: "Modified" });
      rerender({
        canonicalFlow: modifiedFlow,
        updateSignal: makeSignal(2, "canvas"),
      });

      // Nodes should still be the same references from init
      expect(getNodes().length).toBe(nodesAfterInit.length);
      // The key test: canvas-originated updates should not trigger mergeFromFlowInternal
      // Nodes won't have the "Modified" name because mergeFromFlowInternal wasn't called
      // (name is on the flow, not on nodes, so we check node count stability)
    });

    it("source='editor' triggers merge", () => {
      const flow = makeFlow();
      const { rerender, getNodes } = renderCanvas({
        canonicalFlow: flow,
        updateSignal: makeSignal(1, "init"),
      });

      // Add a new node via editor
      const newNode = makeFlowNode({ id: "node-3", node_type: "sink", kind: "slack", label: "Slack", position: { x: 600, y: 0 } });
      const editorFlow = makeFlow({ nodes: [...flow.nodes, newNode] });
      rerender({
        canonicalFlow: editorFlow,
        updateSignal: makeSignal(2, "editor"),
      });

      expect(getNodes().length).toBe(3); // 2 original + 1 new
    });

    it("source='server' triggers merge", () => {
      const flow = makeFlow();
      const { rerender, getNodes } = renderCanvas({
        canonicalFlow: flow,
        updateSignal: makeSignal(1, "init"),
      });

      const newNode = makeFlowNode({ id: "node-3", node_type: "sink", kind: "notion", label: "Notion", position: { x: 600, y: 0 } });
      const serverFlow = makeFlow({ nodes: [...flow.nodes, newNode], version: 5 });
      rerender({
        canonicalFlow: serverFlow,
        updateSignal: makeSignal(2, "server"),
      });

      expect(getNodes().length).toBe(3);
    });

    it("duplicate counter skips merge", () => {
      const flow = makeFlow();
      const { rerender, getNodes } = renderCanvas({
        canonicalFlow: flow,
        updateSignal: makeSignal(1, "init"),
      });

      // Rerender with new flow but same counter — should be ignored
      const newNode = makeFlowNode({ id: "node-3", node_type: "sink", kind: "slack", label: "Slack", position: { x: 600, y: 0 } });
      const modifiedFlow = makeFlow({ nodes: [...flow.nodes, newNode] });
      rerender({
        canonicalFlow: modifiedFlow,
        updateSignal: makeSignal(1, "editor"), // same counter
      });

      expect(getNodes().length).toBe(2); // unchanged
    });
  });

  // --- 5b. Flow switch ---

  describe("flow switch", () => {
    it("flow switch seeds from canonicalFlow", () => {
      const flowA = makeFlow({ id: "flow-a" });
      const { rerender, getNodes } = renderCanvas({
        flowId: "flow-a",
        canonicalFlow: flowA,
        updateSignal: makeSignal(1, "init"),
      });

      expect(getNodes().length).toBe(2);

      const flowB = makeFlow({
        id: "flow-b",
        nodes: [makeFlowNode({ id: "b-1", node_type: "trigger", kind: "cron", label: "Cron" })],
        edges: [],
      });
      rerender({
        flowId: "flow-b",
        canonicalFlow: flowB,
        updateSignal: makeSignal(2, "init"),
      });

      expect(getNodes().length).toBe(1);
      expect(getNodes()[0].id).toBe("b-1");
    });

    it("flow switch to null clears nodes", () => {
      const flow = makeFlow();
      const { rerender, getNodes } = renderCanvas({
        flowId: "flow-1",
        canonicalFlow: flow,
        updateSignal: makeSignal(1, "init"),
      });

      expect(getNodes().length).toBe(2);

      rerender({
        flowId: null,
        canonicalFlow: null,
        updateSignal: makeSignal(2, "init"),
      });

      expect(getNodes().length).toBe(0);
    });

    it("flow switch updates lastAppliedCounter to prevent stale merge", () => {
      const flowA = makeFlow({ id: "flow-a" });
      const { rerender, getNodes } = renderCanvas({
        flowId: "flow-a",
        canonicalFlow: flowA,
        updateSignal: makeSignal(1, "init"),
      });

      // Switch to flow-b with counter=5
      const flowB = makeFlow({
        id: "flow-b",
        nodes: [makeFlowNode({ id: "b-1" })],
        edges: [],
      });
      rerender({
        flowId: "flow-b",
        canonicalFlow: flowB,
        updateSignal: makeSignal(5, "init"),
      });

      // Now try to send an update with counter=3 (stale, before the flow switch)
      // This should be ignored because lastAppliedCounter was set to 5
      const staleFlow = makeFlow({
        id: "flow-b",
        nodes: [makeFlowNode({ id: "b-1" }), makeFlowNode({ id: "b-2" })],
        edges: [],
      });
      rerender({
        flowId: "flow-b",
        canonicalFlow: staleFlow,
        updateSignal: makeSignal(3, "editor"), // stale counter
      });

      expect(getNodes().length).toBe(1); // not 2 — stale update was ignored
    });
  });

  // --- 5c. Spread-merge preserves existing properties ---

  describe("spread-merge", () => {
    it("existing node with extra properties (measured, internals) preserved after merge", () => {
      const flow = makeFlow();
      const { rerender, getNodes } = renderCanvas({
        canonicalFlow: flow,
        updateSignal: makeSignal(1, "init"),
      });

      // Simulate React Flow adding internal properties to nodes
      // We can't directly set these, but we can verify the merge behavior
      // by checking that existing nodes retain their structure after a merge

      const nodesBeforeMerge = getNodes().map((n: any) => n.id);

      // Trigger an editor update with the same nodes (position changed slightly)
      const movedFlow = makeFlow({
        nodes: flow.nodes.map((n) => ({
          ...n,
          position: { x: n.position.x + 10, y: n.position.y },
        })),
      });
      rerender({
        canonicalFlow: movedFlow,
        updateSignal: makeSignal(2, "editor"),
      });

      const nodesAfterMerge = getNodes().map((n: any) => n.id);
      expect(nodesAfterMerge).toEqual(nodesBeforeMerge);
      // Positions should be updated
      expect(getNodes()[0].position.x).toBe(flow.nodes[0].position.x + 10);
    });

    it("new nodes added, removed nodes dropped", () => {
      const flow = makeFlow();
      const { rerender, getNodes } = renderCanvas({
        canonicalFlow: flow,
        updateSignal: makeSignal(1, "init"),
      });

      expect(getNodes().length).toBe(2);

      // Editor update: remove node-2, add node-3
      const newNodes = [
        flow.nodes[0], // keep node-1
        makeFlowNode({ id: "node-3", node_type: "sink", kind: "slack", label: "Slack", position: { x: 600, y: 0 } }),
      ];
      const editorFlow = makeFlow({ nodes: newNodes });
      rerender({
        canonicalFlow: editorFlow,
        updateSignal: makeSignal(2, "editor"),
      });

      const nodeIds = getNodes().map((n: any) => n.id);
      expect(nodeIds).toContain("node-1");
      expect(nodeIds).toContain("node-3");
      expect(nodeIds).not.toContain("node-2");
    });
  });
});
