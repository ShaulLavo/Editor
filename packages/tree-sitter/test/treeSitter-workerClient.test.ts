import { afterEach, describe, expect, it, vi } from "vitest";
import type { TreeSitterLanguageDescriptor } from "../src";

type WorkerClientModule = typeof import("../src/treeSitter/workerClient.ts");

type FakeWorkerRequest = {
  readonly id: number;
  readonly payload: { readonly type: string };
};

const fakeWorkers: FakeWorker[] = [];
let currentClient: WorkerClientModule | null = null;

class FakeWorker {
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public readonly messages: FakeWorkerRequest[] = [];
  private terminated = false;

  public constructor() {
    fakeWorkers.push(this);
  }

  public postMessage(message: FakeWorkerRequest): void {
    this.messages.push(message);
    queueMicrotask(() => this.resolveRequest(message));
  }

  public terminate(): void {
    this.terminated = true;
  }

  private resolveRequest(message: FakeWorkerRequest): void {
    if (this.terminated) return;

    this.onmessage?.({
      data: { id: message.id, ok: true, result: undefined },
    } as MessageEvent);
  }
}

describe("tree-sitter worker client language registration cache", () => {
  afterEach(async () => {
    await currentClient?.disposeTreeSitterWorker();
    currentClient = null;
    fakeWorkers.length = 0;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("does not post duplicate language descriptors", async () => {
    const client = await loadWorkerClient();
    const descriptor = languageDescriptor("typescript");

    await client.registerTreeSitterLanguagesWithWorker([descriptor]);
    await client.registerTreeSitterLanguagesWithWorker([descriptor]);

    expect(registerLanguageRequests()).toHaveLength(1);
  });

  it("posts changed descriptors for the same language id", async () => {
    const client = await loadWorkerClient();

    await client.registerTreeSitterLanguagesWithWorker([languageDescriptor("typescript")]);
    await client.registerTreeSitterLanguagesWithWorker([
      languageDescriptor("typescript", "(identifier) @variable.builtin"),
    ]);

    expect(registerLanguageRequests()).toHaveLength(2);
  });

  it("clears registered descriptor cache when the worker is disposed", async () => {
    const client = await loadWorkerClient();
    const descriptor = languageDescriptor("typescript");

    await client.registerTreeSitterLanguagesWithWorker([descriptor]);
    await client.disposeTreeSitterWorker();
    await client.registerTreeSitterLanguagesWithWorker([descriptor]);

    expect(registerLanguageRequests()).toHaveLength(2);
  });
});

async function loadWorkerClient(): Promise<WorkerClientModule> {
  vi.resetModules();
  fakeWorkers.length = 0;
  vi.stubGlobal("Worker", FakeWorker);
  currentClient = await import("../src/treeSitter/workerClient.ts");
  return currentClient;
}

function registerLanguageRequests(): FakeWorkerRequest[] {
  return fakeWorkers.flatMap((worker) =>
    worker.messages.filter((message) => message.payload.type === "registerLanguages"),
  );
}

function languageDescriptor(
  id: string,
  highlightQuerySource = "(identifier) @variable",
): TreeSitterLanguageDescriptor {
  return {
    aliases: [id],
    extensions: [`.${id}`],
    highlightQuerySource,
    id,
    wasmUrl: `/${id}.wasm`,
  };
}
