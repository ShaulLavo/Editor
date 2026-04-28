import type {
  DocumentSessionChange,
  EditorHighlightResult,
  EditorHighlighterSession,
  EditorHighlighterSessionOptions,
} from "@editor/core";
import type {
  ShikiWorkerDocumentOptions,
  ShikiWorkerRequest,
  ShikiWorkerRequestPayload,
  ShikiWorkerResponse,
  ShikiWorkerResult,
} from "./workerTypes";

export type ShikiHighlighterSessionOptions = EditorHighlighterSessionOptions & {
  readonly lang: string;
  readonly theme: string;
  readonly langs?: readonly string[];
  readonly themes?: readonly string[];
};

type PendingRequest = {
  readonly resolve: (result: ShikiWorkerResult | undefined) => void;
  readonly reject: (error: Error) => void;
};

const supportsWorkers = (): boolean => typeof Worker !== "undefined";

let worker: Worker | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, PendingRequest>();

export const canUseShikiWorker = (): boolean => supportsWorkers();

export function createShikiHighlighterSession(
  options: ShikiHighlighterSessionOptions,
): EditorHighlighterSession | null {
  if (!canUseShikiWorker()) return null;
  return new ShikiHighlighterSession(options);
}

export async function disposeShikiWorker(): Promise<void> {
  if (!worker) return;

  try {
    await postRequest({ type: "dispose" });
  } finally {
    worker.terminate();
    worker = null;
    rejectPendingRequests(new Error("Shiki worker disposed"));
  }
}

class ShikiHighlighterSession implements EditorHighlighterSession {
  private readonly documentId: string;
  private readonly lang: string;
  private readonly theme: string;
  private readonly langs: readonly string[];
  private readonly themes: readonly string[];

  public constructor(options: ShikiHighlighterSessionOptions) {
    this.documentId = options.documentId;
    this.lang = options.lang;
    this.theme = options.theme;
    this.langs = options.langs ?? [];
    this.themes = options.themes ?? [];
  }

  public async refresh(
    _snapshot: ShikiHighlighterSessionOptions["snapshot"],
    text = "",
  ): Promise<EditorHighlightResult> {
    const result = await postRequest({
      type: "open",
      ...this.documentOptions(text),
    });

    return { tokens: result?.tokens ?? [] };
  }

  public async applyChange(change: DocumentSessionChange): Promise<EditorHighlightResult> {
    const payload = this.editPayloadForChange(change);
    const result = await postRequest(payload);
    return { tokens: result?.tokens ?? [] };
  }

  public dispose(): void {
    void postRequest({ type: "disposeDocument", documentId: this.documentId }).catch(
      () => undefined,
    );
  }

  private editPayloadForChange(change: DocumentSessionChange): ShikiWorkerRequestPayload {
    const edit = change.kind === "edit" && change.edits.length === 1 ? change.edits[0] : undefined;
    return {
      type: "edit",
      ...this.documentOptions(change.text),
      edit,
    };
  }

  private documentOptions(text: string): ShikiWorkerDocumentOptions {
    return {
      documentId: this.documentId,
      lang: this.lang,
      theme: this.theme,
      text,
      langs: this.langs,
      themes: this.themes,
    };
  }
}

const getWorker = (): Worker | null => {
  if (!supportsWorkers()) return null;
  if (worker) return worker;

  worker = new Worker(new URL("./shiki.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = handleWorkerMessage;
  worker.onerror = handleWorkerError;
  return worker;
};

const postRequest = (
  payload: ShikiWorkerRequestPayload,
): Promise<ShikiWorkerResult | undefined> => {
  const handle = getWorker();
  if (!handle) return Promise.resolve(undefined);

  const id = nextRequestId++;
  const request: ShikiWorkerRequest = { id, payload };

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    handle.postMessage(request);
  });
};

const handleWorkerMessage = (event: MessageEvent<ShikiWorkerResponse>): void => {
  const response = event.data;
  const pending = pendingRequests.get(response.id);
  if (!pending) return;

  pendingRequests.delete(response.id);
  if (response.ok) {
    pending.resolve(response.result);
    return;
  }

  pending.reject(new Error(response.error));
};

const handleWorkerError = (event: ErrorEvent): void => {
  rejectPendingRequests(new Error(event.message || "Shiki worker failed"));
};

const rejectPendingRequests = (error: Error): void => {
  for (const request of pendingRequests.values()) request.reject(error);
  pendingRequests.clear();
};
