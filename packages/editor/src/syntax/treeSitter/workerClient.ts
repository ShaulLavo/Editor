import type {
  TreeSitterEditRequest,
  TreeSitterLanguageId,
  TreeSitterParseRequest,
  TreeSitterParseResult,
  TreeSitterSelectionRequest,
  TreeSitterSelectionResult,
  TreeSitterWorkerRequest,
  TreeSitterWorkerRequestPayload,
  TreeSitterWorkerResponse,
  TreeSitterWorkerResult,
} from "./types";
import type { PieceTableSnapshot } from "../../pieceTable/pieceTableTypes";

type PendingRequest = {
  readonly documentId: string | null;
  readonly cancellationFlag: Int32Array | null;
  readonly resolve: (result: TreeSitterWorkerResult) => void;
  readonly reject: (error: Error) => void;
};

type TreeSitterParseDocumentRequest = Omit<
  TreeSitterParseRequest,
  "generation" | "cancellationBuffer"
>;
type TreeSitterEditDocumentRequest = TreeSitterEditPayload & { readonly type: "edit" };

export type TreeSitterParsePayload = {
  readonly documentId: string;
  readonly snapshotVersion: number;
  readonly languageId: TreeSitterLanguageId;
  readonly includeHighlights?: boolean;
  readonly text: string;
  readonly snapshot: PieceTableSnapshot;
};

export type TreeSitterEditPayload = Omit<
  TreeSitterEditRequest,
  "type" | "generation" | "cancellationBuffer"
>;
export type TreeSitterSelectionPayload = Omit<TreeSitterSelectionRequest, "type">;

const supportsWorkers = (): boolean => typeof Worker !== "undefined";
const supportsSharedCancellation = (): boolean => typeof SharedArrayBuffer !== "undefined";

let worker: Worker | null = null;
let nextRequestId = 1;
let nextGeneration = 1;
let initPromise: Promise<void> | null = null;
const pendingRequests = new Map<number, PendingRequest>();

const getWorker = (): Worker | null => {
  if (!supportsWorkers()) return null;
  if (worker) return worker;

  worker = new Worker(new URL("./treeSitter.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = handleWorkerMessage;
  worker.onerror = handleWorkerError;
  return worker;
};

const ensureWorkerReady = async (): Promise<Worker | null> => {
  const handle = getWorker();
  if (!handle) return null;

  if (!initPromise) {
    initPromise = postRequest({ type: "init" }).then(() => undefined);
  }

  await initPromise;
  return handle;
};

export const canUseTreeSitterWorker = (): boolean => supportsWorkers();

export const parseWithTreeSitter = async (
  payload: TreeSitterParsePayload,
): Promise<TreeSitterParseResult | undefined> => {
  const handle = await ensureWorkerReady();
  if (!handle) return undefined;
  const request: TreeSitterParseDocumentRequest = {
    type: "parse",
    ...payload,
    includeHighlights: payload.includeHighlights ?? true,
  };
  const result = await postDocumentRequest(request);
  return isTreeSitterParseResult(result) ? result : undefined;
};

export const editWithTreeSitter = async (
  payload: TreeSitterEditPayload,
): Promise<TreeSitterParseResult | undefined> => {
  const handle = await ensureWorkerReady();
  if (!handle) return undefined;
  const result = await postDocumentRequest({ type: "edit", ...payload });
  return isTreeSitterParseResult(result) ? result : undefined;
};

export const selectWithTreeSitter = async (
  payload: TreeSitterSelectionPayload,
): Promise<TreeSitterSelectionResult | undefined> => {
  const handle = await ensureWorkerReady();
  if (!handle) return undefined;
  const result = await postRequest({ type: "selection", ...payload });
  return isTreeSitterSelectionResult(result) ? result : undefined;
};

export const disposeTreeSitterDocument = (documentId: string): void => {
  void postRequest({ type: "disposeDocument", documentId }).catch(() => undefined);
};

export const disposeTreeSitterWorker = async (): Promise<void> => {
  if (!worker) return;

  try {
    await postRequest({ type: "dispose" });
  } finally {
    worker.terminate();
    worker = null;
    initPromise = null;
    rejectPendingRequests(new Error("Tree-sitter worker disposed"));
  }
};

const postRequest = (payload: TreeSitterWorkerRequestPayload): Promise<TreeSitterWorkerResult> => {
  const handle = getWorker();
  if (!handle) return Promise.resolve(undefined);

  const id = nextRequestId++;
  const request: TreeSitterWorkerRequest = { id, payload };

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, {
      documentId: documentIdForPayload(payload),
      cancellationFlag: cancellationFlagForPayload(payload),
      resolve,
      reject,
    });
    handle.postMessage(request);
  });
};

function postDocumentRequest(
  payload: TreeSitterParseDocumentRequest | TreeSitterEditDocumentRequest,
): Promise<TreeSitterWorkerResult> {
  return postRequest(withCancellation(cancelPreviousDocumentRequests(payload.documentId), payload));
}

const cancelPreviousDocumentRequests = (documentId: string): Int32Array | null => {
  let cancellationFlag: Int32Array | null = null;

  for (const pending of pendingRequests.values()) {
    if (pending.documentId !== documentId) continue;
    if (pending.cancellationFlag) Atomics.store(pending.cancellationFlag, 0, 1);
  }

  if (supportsSharedCancellation()) {
    cancellationFlag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  }

  return cancellationFlag;
};

const withCancellation = <
  TPayload extends TreeSitterParseDocumentRequest | TreeSitterEditDocumentRequest,
>(
  cancellationFlag: Int32Array | null,
  payload: TPayload,
): TPayload & { readonly generation: number; readonly cancellationBuffer?: SharedArrayBuffer } => {
  const generation = nextGeneration++;
  if (!cancellationFlag) return { ...payload, generation };
  return {
    ...payload,
    generation,
    cancellationBuffer: cancellationFlag.buffer as SharedArrayBuffer,
  };
};

const handleWorkerMessage = (event: MessageEvent<TreeSitterWorkerResponse>): void => {
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
  const error = new Error(event.message || "Tree-sitter worker failed");
  rejectPendingRequests(error);
  initPromise = null;
};

const rejectPendingRequests = (error: Error): void => {
  for (const request of pendingRequests.values()) request.reject(error);
  pendingRequests.clear();
};

const documentIdForPayload = (payload: TreeSitterWorkerRequestPayload): string | null => {
  if ("documentId" in payload) return payload.documentId;
  return null;
};

const cancellationFlagForPayload = (payload: TreeSitterWorkerRequestPayload): Int32Array | null => {
  if (!("cancellationBuffer" in payload)) return null;
  if (!payload.cancellationBuffer) return null;
  return new Int32Array(payload.cancellationBuffer);
};

const isTreeSitterParseResult = (result: TreeSitterWorkerResult): result is TreeSitterParseResult =>
  Boolean(result && "captures" in result && "folds" in result);

const isTreeSitterSelectionResult = (
  result: TreeSitterWorkerResult,
): result is TreeSitterSelectionResult =>
  Boolean(result && "status" in result && "ranges" in result);
