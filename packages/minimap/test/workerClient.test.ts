import { describe, expect, it, vi } from "vitest";
import type { EditorViewSnapshot } from "@editor/core";
import { resolveMinimapOptions } from "../src/options";
import { MinimapWorkerClient, type MinimapHost } from "../src/workerClient";
import type { MinimapWorkerResponse } from "../src/types";

describe("MinimapWorkerClient", () => {
  it("skips layout updates for scroll-only viewport changes", () => {
    const runtime = installMinimapRuntime();
    try {
      const host = createHost();
      const client = new MinimapWorkerClient({
        host,
        options: resolveMinimapOptions(),
        snapshot: snapshot({ scrollTop: 0 }),
        onLayoutWidth: vi.fn(),
      });
      const worker = runtime.workers[0]!;
      worker.send(renderedResponse(1));
      worker.postMessage.mockClear();

      client.update(snapshot({ scrollTop: 120, visibleRange: { start: 6, end: 18 } }), "viewport");
      runtime.flushAnimationFrames();

      const requests = worker.postMessage.mock.calls.map((call) => call[0] as { type: string });

      expect(requests.map((request) => request.type)).toEqual(["updateViewport", "render"]);

      client.dispose();
      host.root.remove();
      host.colorScope.remove();
    } finally {
      runtime.restore();
    }
  });
});

function createHost(): MinimapHost {
  const root = document.createElement("div");
  const colorScope = document.createElement("div");
  const shadow = document.createElement("div");
  const mainCanvas = document.createElement("canvas");
  const decorationsCanvas = document.createElement("canvas");
  const slider = document.createElement("div");
  const sliderHorizontal = document.createElement("div");
  colorScope.style.color = "rgb(212, 212, 212)";
  colorScope.style.backgroundColor = "rgb(30, 30, 30)";
  slider.appendChild(sliderHorizontal);
  root.append(shadow, mainCanvas, decorationsCanvas, slider);
  document.body.append(colorScope, root);
  return { root, colorScope, shadow, mainCanvas, decorationsCanvas, slider, sliderHorizontal };
}

function snapshot(viewport: Partial<EditorViewSnapshot["viewport"]> = {}): EditorViewSnapshot {
  return {
    documentId: "minimap-test",
    languageId: "typescript",
    text: "line 1\nline 2\nline 3",
    textVersion: 1,
    lineStarts: [0, 7, 14],
    tokens: [],
    selections: [],
    metrics: { rowHeight: 20, characterWidth: 8 },
    lineCount: 3,
    contentWidth: 160,
    totalHeight: 60,
    tabSize: 4,
    foldMarkers: [],
    visibleRows: [],
    viewport: {
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 400,
      scrollWidth: 160,
      clientHeight: 100,
      clientWidth: 240,
      borderBoxHeight: 100,
      borderBoxWidth: 240,
      visibleRange: { start: 0, end: 3 },
      ...viewport,
    },
  };
}

function renderedResponse(sequence: number): MinimapWorkerResponse {
  return {
    type: "rendered",
    sequence,
    sliderNeeded: true,
    sliderTop: 0,
    sliderHeight: 20,
    shadowVisible: false,
  };
}

function installMinimapRuntime(): {
  readonly workers: MockWorker[];
  readonly flushAnimationFrames: () => void;
  readonly restore: () => void;
} {
  const workers: MockWorker[] = [];
  const frames: (() => void)[] = [];
  const worker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const offscreenCanvas = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
  const requestAnimationFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestAnimationFrame",
  );
  const cancelAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const transferControlToOffscreen = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    "transferControlToOffscreen",
  );

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: class extends MockWorker {
      public constructor(url: URL, options?: WorkerOptions) {
        super(url, options);
        workers.push(this);
      }
    },
  });
  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    value: class MockOffscreenCanvas {},
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "transferControlToOffscreen", {
    configurable: true,
    value: () => ({}),
  });

  return {
    workers,
    flushAnimationFrames: () => {
      for (const frame of frames.splice(0)) frame();
    },
    restore: () => {
      restoreDescriptor(globalThis, "Worker", worker);
      restoreDescriptor(globalThis, "OffscreenCanvas", offscreenCanvas);
      restoreDescriptor(globalThis, "requestAnimationFrame", requestAnimationFrame);
      restoreDescriptor(globalThis, "cancelAnimationFrame", cancelAnimationFrame);
      restoreDescriptor(
        HTMLCanvasElement.prototype,
        "transferControlToOffscreen",
        transferControlToOffscreen,
      );
    },
  };
}

class MockWorker {
  public onmessage: ((event: MessageEvent<MinimapWorkerResponse>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public postMessage = vi.fn();
  public terminate = vi.fn();

  public constructor(_url: URL, _options?: WorkerOptions) {}

  public send(response: MinimapWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<MinimapWorkerResponse>);
  }
}

function restoreDescriptor(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
    return;
  }

  Reflect.deleteProperty(target, property);
}
