// Global mocks for jsdom environment

// React Flow needs ResizeObserver
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

// React Flow needs IntersectionObserver
class IntersectionObserverMock {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds: readonly number[] = [];
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}
globalThis.IntersectionObserver = IntersectionObserverMock as unknown as typeof IntersectionObserver;

// matchMedia mock
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Deterministic UUIDs for tests
let uuidCounter = 0;
globalThis.crypto.randomUUID = () => {
  uuidCounter += 1;
  return `test-uuid-${String(uuidCounter).padStart(4, "0")}` as `${string}-${string}-${string}-${string}-${string}`;
};

// Reset UUID counter between tests
beforeEach(() => {
  uuidCounter = 0;
});
