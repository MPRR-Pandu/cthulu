import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFlowDispatch, type FlowDispatchAPI } from "./useFlowDispatch";
import { makeFlow } from "../test/fixtures";

function createMockApi(overrides: Partial<FlowDispatchAPI> = {}): FlowDispatchAPI {
  return {
    onSaveComplete: vi.fn(),
    updateFlow: vi.fn<Parameters<FlowDispatchAPI["updateFlow"]>, ReturnType<FlowDispatchAPI["updateFlow"]>>().mockResolvedValue(makeFlow({ version: 2 })),
    getFlow: vi.fn<Parameters<FlowDispatchAPI["getFlow"]>, ReturnType<FlowDispatchAPI["getFlow"]>>().mockResolvedValue(makeFlow({ version: 3 })),
    ...overrides,
  };
}

function setup(apiOverrides: Partial<FlowDispatchAPI> = {}) {
  const mockApi = createMockApi(apiOverrides);
  const activeFlowIdRef = { current: "flow-1" as string | null };

  const { result } = renderHook(() =>
    useFlowDispatch(mockApi, activeFlowIdRef)
  );

  // Initialize with a flow so canonicalFlow is non-null
  act(() => {
    result.current.initFlow(makeFlow());
  });

  return { result, mockApi, activeFlowIdRef };
}

describe("useFlowDispatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- 3a. Basic dispatch behavior ---

  describe("basic dispatch behavior", () => {
    it("dispatch('canvas') merges nodes/edges into canonicalFlow", () => {
      const { result } = setup();
      const newNodes = [{ id: "n1", node_type: "trigger" as const, kind: "manual", config: {}, position: { x: 10, y: 20 }, label: "New" }];
      const newEdges = [{ id: "e1", source: "n1", target: "n2" }];

      act(() => {
        result.current.dispatchFlowUpdate("canvas", { nodes: newNodes, edges: newEdges });
      });

      expect(result.current.canonicalFlow!.nodes).toEqual(newNodes);
      expect(result.current.canonicalFlow!.edges).toEqual(newEdges);
      expect(result.current.canonicalFlow!.version).toBe(1); // version unchanged
    });

    it("dispatch('editor') updates canonicalFlow, preserves version", () => {
      const { result } = setup();
      const newNodes = [{ id: "n1", node_type: "executor" as const, kind: "claude-code", config: {}, position: { x: 0, y: 0 }, label: "Exec" }];

      act(() => {
        result.current.dispatchFlowUpdate("editor", { nodes: newNodes, name: "Renamed" });
      });

      expect(result.current.canonicalFlow!.nodes).toEqual(newNodes);
      expect(result.current.canonicalFlow!.name).toBe("Renamed");
      expect(result.current.canonicalFlow!.version).toBe(1); // version preserved
    });

    it("dispatch('server') updates canonicalFlow and flowVersionRef", () => {
      const { result } = setup();

      act(() => {
        result.current.dispatchFlowUpdate("server", { version: 5, name: "Server Update" });
      });

      expect(result.current.canonicalFlow!.name).toBe("Server Update");
      expect(result.current.flowVersionRef.current).toBe(5);
    });

    it("dispatch('init') via initFlow updates canonicalFlow without save", () => {
      const { result, mockApi } = setup();

      act(() => {
        result.current.initFlow(makeFlow({ name: "Init Flow", version: 10 }));
      });

      expect(result.current.canonicalFlow!.name).toBe("Init Flow");
      expect(result.current.flowVersionRef.current).toBe(10);

      // Advance past debounce — no save should happen
      act(() => { vi.advanceTimersByTime(1000); });
      expect(mockApi.updateFlow).not.toHaveBeenCalled();
    });
  });

  // --- 3b. Counter + signal ---

  describe("counter and signal", () => {
    it("each dispatch increments counter by exactly 1", () => {
      const { result } = setup();

      act(() => {
        result.current.dispatchFlowUpdate("canvas", { name: "A" });
      });
      const c1 = result.current.updateSignal.counter;

      act(() => {
        result.current.dispatchFlowUpdate("editor", { name: "B" });
      });
      const c2 = result.current.updateSignal.counter;

      expect(c2 - c1).toBe(1);
    });

    it("signal source matches the dispatch source argument", () => {
      const { result } = setup();

      act(() => {
        result.current.dispatchFlowUpdate("canvas", { name: "A" });
      });
      expect(result.current.updateSignal.source).toBe("canvas");

      act(() => {
        result.current.dispatchFlowUpdate("editor", { name: "B" });
      });
      expect(result.current.updateSignal.source).toBe("editor");

      act(() => {
        result.current.dispatchFlowUpdate("server", { name: "C" });
      });
      expect(result.current.updateSignal.source).toBe("server");
    });

    it("3 rapid dispatches produce monotonic counters 1, 2, 3 relative to init", () => {
      const { result } = setup();
      const initCounter = result.current.updateSignal.counter;

      act(() => {
        result.current.dispatchFlowUpdate("canvas", { name: "A" });
        result.current.dispatchFlowUpdate("editor", { name: "B" });
        result.current.dispatchFlowUpdate("server", { name: "C" });
      });

      // After 3 dispatches, counter should be initCounter + 3
      expect(result.current.updateSignal.counter).toBe(initCounter + 3);
    });
  });

  // --- 3c. Debounced save ---

  describe("debounced save", () => {
    it("dispatch('canvas') triggers api.updateFlow after 500ms", async () => {
      const { result, mockApi } = setup();

      act(() => {
        result.current.dispatchFlowUpdate("canvas", { name: "Save Me" });
      });

      expect(mockApi.updateFlow).not.toHaveBeenCalled();

      // Advance timer and flush all microtasks
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(mockApi.updateFlow).toHaveBeenCalledTimes(1);
    });

    it("dispatch('server') does NOT trigger api.updateFlow", async () => {
      const { result, mockApi } = setup();

      act(() => {
        result.current.dispatchFlowUpdate("server", { name: "Server" });
      });

      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      expect(mockApi.updateFlow).not.toHaveBeenCalled();
    });

    it("initFlow does NOT trigger api.updateFlow", async () => {
      const { result, mockApi } = setup();

      act(() => {
        result.current.initFlow(makeFlow({ name: "Init" }));
      });

      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      expect(mockApi.updateFlow).not.toHaveBeenCalled();
    });

    it("3 rapid canvas dispatches result in only 1 api.updateFlow call", async () => {
      const { result, mockApi } = setup();

      act(() => {
        result.current.dispatchFlowUpdate("canvas", { name: "A" });
        result.current.dispatchFlowUpdate("canvas", { name: "B" });
        result.current.dispatchFlowUpdate("canvas", { name: "C" });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(mockApi.updateFlow).toHaveBeenCalledTimes(1);
    });
  });

  // --- 3d. Version + conflict ---

  describe("version and conflict handling", () => {
    it("successful save updates flowVersionRef and canonicalFlow.version", async () => {
      const { result, mockApi } = setup();
      (mockApi.updateFlow as ReturnType<typeof vi.fn>).mockResolvedValue(makeFlow({ version: 7 }));

      act(() => {
        result.current.dispatchFlowUpdate("canvas", { name: "Save" });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(result.current.flowVersionRef.current).toBe(7);
      expect(result.current.canonicalFlow!.version).toBe(7);
    });

    it("successful save does NOT bump updateSignal counter", async () => {
      const { result, mockApi } = setup();
      (mockApi.updateFlow as ReturnType<typeof vi.fn>).mockResolvedValue(makeFlow({ version: 7 }));

      act(() => {
        result.current.dispatchFlowUpdate("canvas", { name: "Save" });
      });
      const counterAfterDispatch = result.current.updateSignal.counter;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      // Counter should not have changed after save
      expect(result.current.updateSignal.counter).toBe(counterAfterDispatch);
    });

    it("409 conflict triggers getFlow and dispatches server update", async () => {
      const freshFlow = makeFlow({ version: 10, name: "Fresh From Server" });
      const { result, mockApi } = setup({
        updateFlow: vi.fn().mockRejectedValue(new Error("API error 409: conflict")),
        getFlow: vi.fn().mockResolvedValue(freshFlow),
      });

      act(() => {
        result.current.dispatchFlowUpdate("canvas", { name: "Conflict" });
      });

      const counterBeforeSave = result.current.updateSignal.counter;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(mockApi.getFlow).toHaveBeenCalledWith("flow-1");
      expect(result.current.canonicalFlow!.name).toBe("Fresh From Server");
      expect(result.current.flowVersionRef.current).toBe(10);
      // Counter should have bumped from the server dispatch
      expect(result.current.updateSignal.counter).toBeGreaterThan(counterBeforeSave);
      expect(result.current.updateSignal.source).toBe("server");
    });
  });

  // --- No-diff guard ---

  describe("no-diff guard", () => {
    it("dispatch with identical data does not bump counter or schedule save", async () => {
      const { result, mockApi } = setup();
      const counterAfterInit = result.current.updateSignal.counter;

      // Dispatch with the same name/nodes/edges as the init flow
      act(() => {
        result.current.dispatchFlowUpdate("canvas", {
          name: result.current.canonicalFlow!.name,
          nodes: result.current.canonicalFlow!.nodes,
          edges: result.current.canonicalFlow!.edges,
        });
      });

      expect(result.current.updateSignal.counter).toBe(counterAfterInit);

      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(mockApi.updateFlow).not.toHaveBeenCalled();
    });

    it("server dispatch with same data but new version updates version silently", () => {
      const { result } = setup();
      const counterAfterInit = result.current.updateSignal.counter;

      act(() => {
        result.current.dispatchFlowUpdate("server", {
          name: result.current.canonicalFlow!.name,
          nodes: result.current.canonicalFlow!.nodes,
          edges: result.current.canonicalFlow!.edges,
          version: 99,
        });
      });

      // Version updated but counter NOT bumped
      expect(result.current.flowVersionRef.current).toBe(99);
      expect(result.current.canonicalFlow!.version).toBe(99);
      expect(result.current.updateSignal.counter).toBe(counterAfterInit);
    });

    it("SSE echo with identical content is a no-op", async () => {
      const { result } = setup();

      // First, make a real change
      act(() => {
        result.current.dispatchFlowUpdate("editor", { name: "Edited" });
      });
      const counterAfterEdit = result.current.updateSignal.counter;

      // SSE echo arrives with same content but new version
      act(() => {
        result.current.dispatchFlowUpdate("server", {
          name: "Edited",
          nodes: result.current.canonicalFlow!.nodes,
          edges: result.current.canonicalFlow!.edges,
          version: 5,
        });
      });

      // Version updated silently, counter NOT bumped
      expect(result.current.flowVersionRef.current).toBe(5);
      expect(result.current.updateSignal.counter).toBe(counterAfterEdit);
    });
  });

  // --- Save cancellation on flow switch ---

  describe("save cancellation on flow switch", () => {
    it("initFlow cancels pending save from previous flow", async () => {
      const { result, mockApi } = setup();

      // Dispatch a canvas change that schedules a debounced save
      act(() => {
        result.current.dispatchFlowUpdate("canvas", { name: "Unsaved Change" });
      });

      // Before the 500ms debounce fires, switch to a new flow
      act(() => {
        result.current.initFlow(makeFlow({ id: "flow-2", name: "New Flow", version: 5 }));
      });

      // Advance past the debounce window
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      // The save from the old flow should NOT have fired
      expect(mockApi.updateFlow).not.toHaveBeenCalled();
    });
  });
});
