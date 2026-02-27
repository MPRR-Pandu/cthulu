import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import App from "./App";
import * as api from "./api/client";
import { makeFlow } from "./test/fixtures";

// --- Mock API client ---
vi.mock("./api/client", () => ({
  listFlows: vi.fn().mockResolvedValue([]),
  getFlow: vi.fn(),
  createFlow: vi.fn(),
  updateFlow: vi.fn(),
  getNodeTypes: vi.fn().mockResolvedValue([]),
  getServerUrl: vi.fn().mockReturnValue("http://localhost:8081"),
  setServerUrl: vi.fn(),
  subscribeToChanges: vi.fn().mockReturnValue(() => {}),
  triggerFlow: vi.fn(),
  listAgents: vi.fn().mockResolvedValue([]),
  getAgent: vi.fn(),
}));

// --- Mock runStream ---
vi.mock("./api/runStream", () => ({
  subscribeToRuns: vi.fn().mockReturnValue(() => {}),
}));

// --- Mock logger ---
vi.mock("./api/logger", () => ({
  log: vi.fn(),
}));

// --- Mock heavy components ---
vi.mock("./components/TopBar", () => ({
  default: (props: any) => (
    <div data-testid="topbar">
      <span data-testid="topbar-flow-name">{props.flow?.name || ""}</span>
    </div>
  ),
}));

vi.mock("./components/Sidebar", () => ({
  default: (props: any) => (
    <div data-testid="sidebar">
      <button data-testid="select-flow" onClick={() => props.onSelectFlow("flow-1")} />
    </div>
  ),
}));

vi.mock("./components/FlowWorkspaceView", () => ({
  default: (props: any) => (
    <div data-testid="flow-workspace">
      <span data-testid="editor-text">{props.updateSignal.source}</span>
      <span data-testid="signal-counter">{props.updateSignal.counter}</span>
      <button
        data-testid="editor-change"
        onClick={() => {
          // Simulate editor onChange with valid JSON
          const flow = props.canonicalFlow;
          if (flow) {
            props.onEditorChange(JSON.stringify({ ...flow, name: "Edited" }, null, 2));
          }
        }}
      />
      <button
        data-testid="canvas-change"
        onClick={() => {
          if (props.canonicalFlow) {
            props.onCanvasChange({ nodes: props.canonicalFlow.nodes, edges: props.canonicalFlow.edges });
          }
        }}
      />
    </div>
  ),
}));

vi.mock("./components/AgentWorkspaceView", () => ({
  default: () => <div data-testid="agent-workspace" />,
}));

vi.mock("./components/Canvas", () => ({
  default: null, // Canvas is only used for the type CanvasHandle
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

describe("App integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.listFlows as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (api.getNodeTypes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it("selectFlow loads flow and passes it to workspace with init signal", async () => {
    const flow = makeFlow({ id: "flow-1", name: "Test Flow" });
    (api.getFlow as ReturnType<typeof vi.fn>).mockResolvedValue(flow);

    render(<App />);

    // Click select flow button in sidebar
    await act(async () => {
      screen.getByTestId("select-flow").click();
    });

    // Wait for async getFlow to resolve
    await act(async () => {});

    expect(api.getFlow).toHaveBeenCalledWith("flow-1");
    expect(screen.getByTestId("editor-text").textContent).toBe("init");
    expect(Number(screen.getByTestId("signal-counter").textContent)).toBeGreaterThan(0);
  });

  it("editor onChange dispatches with source='editor'", async () => {
    const flow = makeFlow({ id: "flow-1", name: "Test Flow" });
    (api.getFlow as ReturnType<typeof vi.fn>).mockResolvedValue(flow);

    render(<App />);

    // First select a flow
    await act(async () => {
      screen.getByTestId("select-flow").click();
    });
    await act(async () => {});

    const counterAfterSelect = Number(screen.getByTestId("signal-counter").textContent);

    // Now simulate editor change
    await act(async () => {
      screen.getByTestId("editor-change").click();
    });

    expect(screen.getByTestId("editor-text").textContent).toBe("editor");
    expect(Number(screen.getByTestId("signal-counter").textContent)).toBe(counterAfterSelect + 1);
  });

  it("SSE server event dispatches with source='server' and updates both editor and canvas", async () => {
    let sseCallback: ((event: any) => void) | null = null;
    (api.subscribeToChanges as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => {
      sseCallback = cb;
      return () => {};
    });

    const flow = makeFlow({ id: "flow-1", name: "Original" });
    const serverFlow = makeFlow({ id: "flow-1", name: "Server Updated", version: 5 });
    (api.getFlow as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(flow) // selectFlow
      .mockResolvedValueOnce(serverFlow); // SSE re-fetch

    render(<App />);

    // Select a flow
    await act(async () => {
      screen.getByTestId("select-flow").click();
    });
    await act(async () => {});

    const counterAfterSelect = Number(screen.getByTestId("signal-counter").textContent);

    // Simulate SSE flow_change event
    await act(async () => {
      sseCallback?.({
        resource_type: "flow",
        change_type: "updated",
        resource_id: "flow-1",
        timestamp: new Date().toISOString(),
      });
    });

    // Wait for the async getFlow in the SSE handler
    await act(async () => {});

    expect(screen.getByTestId("editor-text").textContent).toBe("server");
    expect(Number(screen.getByTestId("signal-counter").textContent)).toBeGreaterThan(counterAfterSelect);
  });

  it("SSE with different version DOES dispatch server update", async () => {
    let sseCallback: ((event: any) => void) | null = null;
    (api.subscribeToChanges as ReturnType<typeof vi.fn>).mockImplementation((cb: any) => {
      sseCallback = cb;
      return () => {};
    });

    const flow = makeFlow({ id: "flow-1", name: "Original", version: 3 });
    // SSE re-fetch returns DIFFERENT version → should dispatch
    const externalFlow = makeFlow({ id: "flow-1", name: "External Edit", version: 4 });
    (api.getFlow as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(flow)         // selectFlow
      .mockResolvedValueOnce(externalFlow); // SSE re-fetch (external change)

    render(<App />);

    await act(async () => {
      screen.getByTestId("select-flow").click();
    });
    await act(async () => {});

    const counterAfterSelect = Number(screen.getByTestId("signal-counter").textContent);

    // Simulate SSE with different version
    await act(async () => {
      sseCallback?.({
        resource_type: "flow",
        change_type: "updated",
        resource_id: "flow-1",
        timestamp: new Date().toISOString(),
      });
    });
    await act(async () => {});

    // Signal SHOULD have changed — external update was applied
    expect(screen.getByTestId("editor-text").textContent).toBe("server");
    expect(Number(screen.getByTestId("signal-counter").textContent)).toBeGreaterThan(counterAfterSelect);
  });
});
