import {
  applyBatchToPieceTable,
  createDocumentTextSnapshot,
  documentSessionChangeTextSnapshot,
  offsetToPoint,
  pieceTableSnapshotsHaveSameText,
  treeSitterCapturesToEditorTokens,
  type DocumentSessionChange,
  type DocumentTextSnapshot,
  type EditorSyntaxResult,
  type EditorSyntaxSession,
  type PieceTableSnapshot,
  type TextEdit,
} from "@editor/core";
import type {
  TreeSitterInputEdit,
  TreeSitterLanguageId,
  TreeSitterParseResult,
} from "./treeSitter/types";
import type { TreeSitterLanguageResolver } from "./treeSitter/registry";
import {
  createTreeSitterWorkerBackend,
  type TreeSitterBackend,
  type TreeSitterEditPayload,
} from "./treeSitter/workerClient";

export type TreeSitterSyntaxSessionOptions = {
  readonly documentId: string;
  readonly languageId: TreeSitterLanguageId;
  readonly languageResolver?: TreeSitterLanguageResolver;
  readonly includeHighlights?: boolean;
  readonly text?: string;
  readonly textSnapshot?: DocumentTextSnapshot;
  readonly snapshot: PieceTableSnapshot;
  readonly backend?: TreeSitterBackend;
};

export class TreeSitterSyntaxSession implements EditorSyntaxSession {
  private readonly documentId: string;
  private readonly languageId: TreeSitterLanguageId;
  private readonly languageResolver: TreeSitterLanguageResolver | undefined;
  private readonly includeHighlights: boolean;
  private readonly backend: TreeSitterBackend;
  private snapshotVersion = 0;
  private parsedSnapshotVersion = 0;
  private textSnapshot: DocumentTextSnapshot;
  private snapshot: PieceTableSnapshot;
  private result: EditorSyntaxResult = createEmptySyntaxResult();
  private languageRegistrationPromise: Promise<boolean> | null = null;

  public constructor(options: TreeSitterSyntaxSessionOptions) {
    this.documentId = options.documentId;
    this.languageId = options.languageId;
    this.languageResolver = options.languageResolver;
    this.includeHighlights = options.includeHighlights ?? true;
    this.textSnapshot =
      options.textSnapshot ?? createDocumentTextSnapshot(options.snapshot, options.text);
    this.snapshot = options.snapshot;
    this.backend = options.backend ?? createTreeSitterWorkerBackend();
  }

  public async refresh(snapshot: PieceTableSnapshot, text?: string): Promise<EditorSyntaxResult> {
    const snapshotVersion = ++this.snapshotVersion;
    const textSnapshot = createDocumentTextSnapshot(snapshot, text);
    if (!(await this.ensureLanguageRegistered())) {
      return this.updateFromUnavailableLanguage(textSnapshot, snapshot);
    }

    const result = await this.backend.parse({
      documentId: this.documentId,
      snapshotVersion,
      languageId: this.languageId,
      includeHighlights: this.includeHighlights,
      snapshot,
    });

    return this.updateFromTreeSitterResult(result, snapshotVersion, textSnapshot, snapshot);
  }

  public async applyChange(change: DocumentSessionChange): Promise<EditorSyntaxResult> {
    if (change.kind === "none" || change.kind === "selection") return this.result;
    if (!(await this.ensureLanguageRegistered())) {
      this.snapshotVersion += 1;
      return this.updateFromUnavailableLanguage(
        documentSessionChangeTextSnapshot(change),
        change.snapshot,
      );
    }

    const edits = createSyntaxTextEdits(this.textSnapshot, this.snapshot, change);
    if (edits.length === 0) {
      this.textSnapshot = documentSessionChangeTextSnapshot(change);
      this.snapshot = change.snapshot;
      return this.result;
    }

    const payload = createTreeSitterEditPayload({
      documentId: this.documentId,
      languageId: this.languageId,
      previousSnapshotVersion: this.parsedSnapshotVersion,
      snapshotVersion: ++this.snapshotVersion,
      previousSnapshot: this.snapshot,
      nextSnapshot: change.snapshot,
      edits,
      includeHighlights: this.includeHighlights,
    });

    if (!payload) return this.refresh(change.snapshot);
    return this.applyIncrementalEdit(payload, documentSessionChangeTextSnapshot(change));
  }

  public getResult(): EditorSyntaxResult {
    return this.result;
  }

  public getTokens(): readonly EditorSyntaxResult["tokens"][number][] {
    return this.result.tokens;
  }

  public getSnapshotVersion(): number {
    return this.snapshotVersion;
  }

  public dispose(): void {
    this.backend.disposeDocument(this.documentId);
  }

  private async applyIncrementalEdit(
    payload: TreeSitterEditPayload,
    nextTextSnapshot: DocumentTextSnapshot,
  ): Promise<EditorSyntaxResult> {
    try {
      const result = await this.backend.edit(payload);
      return this.updateFromTreeSitterResult(
        result,
        payload.snapshotVersion,
        nextTextSnapshot,
        payload.snapshot,
      );
    } catch (error) {
      if (!isRecoverableIncrementalEditError(error)) throw error;
      return this.refresh(payload.snapshot);
    }
  }

  private ensureLanguageRegistered(): Promise<boolean> {
    if (!this.languageResolver) return Promise.resolve(true);
    if (!this.languageRegistrationPromise) {
      this.languageRegistrationPromise = this.registerResolvedLanguage();
    }

    return this.languageRegistrationPromise;
  }

  private async registerResolvedLanguage(): Promise<boolean> {
    const descriptor = await this.languageResolver?.resolveTreeSitterLanguage(this.languageId);
    if (!descriptor) return false;

    await this.backend.registerLanguages([descriptor]);
    return true;
  }

  private updateFromUnavailableLanguage(
    textSnapshot: DocumentTextSnapshot,
    snapshot: PieceTableSnapshot,
  ): EditorSyntaxResult {
    this.textSnapshot = textSnapshot;
    this.snapshot = snapshot;
    this.result = createEmptySyntaxResult();
    return this.result;
  }

  private updateFromTreeSitterResult(
    result: TreeSitterParseResult | undefined,
    snapshotVersion: number,
    textSnapshot: DocumentTextSnapshot,
    snapshot: PieceTableSnapshot,
  ): EditorSyntaxResult {
    if (!result) return this.result;
    if (result.snapshotVersion !== snapshotVersion) return this.result;
    if (result.snapshotVersion !== this.snapshotVersion) return this.result;

    this.textSnapshot = textSnapshot;
    this.snapshot = snapshot;
    this.parsedSnapshotVersion = result.snapshotVersion;
    this.result = treeSitterParseResultToEditorSyntaxResult(result);
    return this.result;
  }
}

type TreeSitterEditPayloadOptions = {
  readonly documentId: string;
  readonly languageId: TreeSitterLanguageId;
  readonly previousSnapshotVersion: number;
  readonly snapshotVersion: number;
  readonly previousSnapshot: PieceTableSnapshot;
  readonly nextSnapshot: PieceTableSnapshot;
  readonly edits: readonly TextEdit[];
  readonly includeHighlights?: boolean;
};

export const createTreeSitterEditPayload = (
  options: TreeSitterEditPayloadOptions,
): TreeSitterEditPayload | null => {
  if (options.edits.length === 0) return null;

  return {
    documentId: options.documentId,
    previousSnapshotVersion: options.previousSnapshotVersion,
    snapshotVersion: options.snapshotVersion,
    languageId: options.languageId,
    includeHighlights: options.includeHighlights ?? true,
    snapshot: options.nextSnapshot,
    edits: options.edits,
    inputEdits: createTreeSitterInputEdits(options.previousSnapshot, options.edits),
  };
};

export const createTextDiffEdit = (previousText: string, nextText: string): TextEdit | null => {
  if (previousText === nextText) return null;

  let start = 0;
  const maxPrefixLength = Math.min(previousText.length, nextText.length);
  while (start < maxPrefixLength && previousText[start] === nextText[start]) start += 1;

  let previousEnd = previousText.length;
  let nextEnd = nextText.length;
  while (
    previousEnd > start &&
    nextEnd > start &&
    previousText[previousEnd - 1] === nextText[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  return {
    from: start,
    to: previousEnd,
    text: nextText.slice(start, nextEnd),
  };
};

const createSyntaxTextEdits = (
  previousTextSnapshot: DocumentTextSnapshot,
  previousSnapshot: PieceTableSnapshot,
  change: DocumentSessionChange,
): readonly TextEdit[] => {
  if (changeEditsApplyToSnapshot(previousSnapshot, change)) return change.edits;

  const edit = createTextDiffEdit(
    previousTextSnapshot.getText(),
    documentSessionChangeTextSnapshot(change).getText(),
  );
  return edit ? [edit] : [];
};

const changeEditsApplyToSnapshot = (
  snapshot: PieceTableSnapshot,
  change: DocumentSessionChange,
): boolean => {
  try {
    return pieceTableSnapshotsHaveSameText(
      applyBatchToPieceTable(snapshot, change.edits),
      change.snapshot,
    );
  } catch {
    return false;
  }
};

const treeSitterParseResultToEditorSyntaxResult = (
  result: TreeSitterParseResult,
): EditorSyntaxResult => ({
  captures: result.captures,
  folds: result.folds,
  brackets: result.brackets,
  errors: result.errors,
  injections: result.injections,
  tokens: treeSitterCapturesToEditorTokens(result.captures),
});

const createEmptySyntaxResult = (): EditorSyntaxResult => ({
  captures: [],
  folds: [],
  brackets: [],
  errors: [],
  injections: [],
  tokens: [],
});

const createTreeSitterInputEdits = (
  snapshot: PieceTableSnapshot,
  edits: readonly TextEdit[],
): TreeSitterInputEdit[] => {
  const sorted = edits.toSorted((left, right) => right.from - left.from || right.to - left.to);
  const inputEdits: TreeSitterInputEdit[] = [];
  let workingSnapshot = snapshot;

  for (const edit of sorted) {
    const startPosition = offsetToPoint(workingSnapshot, edit.from);
    const oldEndPosition = offsetToPoint(workingSnapshot, edit.to);
    const nextSnapshot = applyBatchToPieceTable(workingSnapshot, [edit]);
    const newEndIndex = edit.from + edit.text.length;

    inputEdits.push({
      startIndex: edit.from,
      oldEndIndex: edit.to,
      newEndIndex,
      startPosition,
      oldEndPosition,
      newEndPosition: offsetToPoint(nextSnapshot, newEndIndex),
    });
    workingSnapshot = nextSnapshot;
  }

  return inputEdits;
};

const isRecoverableIncrementalEditError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("cache miss");
