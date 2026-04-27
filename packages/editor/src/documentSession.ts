import {
  applyTextToSelections,
  backspaceSelections,
  createAnchorSelection,
  createSelectionSet,
  deleteSelections,
  type SelectionSet,
} from "./selections";
import {
  commitEditorHistory,
  createEditorHistory,
  redoEditorHistory,
  undoEditorHistory,
  type PieceTableEditorHistory,
} from "./history";
import type { EditorToken, TextEdit } from "./tokens";
import {
  createPieceTableSnapshot,
  getPieceTableText,
  type PieceTableAnchor,
  type PieceTableSnapshot,
} from "./pieceTable";
import {
  createPosttextLayoutSession,
  getPosttextRangeBoxes,
  posttextOffsetToXY,
  posttextXYToOffset,
  queryNoWrapPosttextViewport,
  setPosttextLayoutSessionMetrics,
  updatePosttextLayoutSession,
  type PosttextLayout,
  type PosttextLayoutMetrics,
  type PosttextLayoutSession,
  type PosttextLayoutUpdateMode,
  type PosttextRangeBox,
  type PosttextViewport,
  type PosttextViewportResult,
  type PosttextXY,
} from "./layout";

export type DocumentSessionChangeKind = "edit" | "selection" | "undo" | "redo" | "none";

export type EditorTimingMeasurement = {
  readonly name: string;
  readonly durationMs: number;
};

export type DocumentSessionChange = {
  readonly kind: DocumentSessionChangeKind;
  readonly edits: readonly TextEdit[];
  readonly snapshot: PieceTableSnapshot;
  readonly selections: SelectionSet<PieceTableAnchor>;
  readonly text: string;
  readonly tokens: readonly EditorToken[];
  readonly timings: readonly EditorTimingMeasurement[];
  readonly layout: DocumentSessionLayoutSummary;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
};

export type DocumentSessionLayoutSummary = {
  readonly revision: number;
  readonly updateMode: PosttextLayoutUpdateMode;
  readonly rebuildCount: number;
  readonly incrementalUpdateCount: number;
  readonly reuseCount: number;
  readonly lineCount: number;
  readonly width: number;
  readonly height: number;
};

export type DocumentSession = {
  applyText(text: string): DocumentSessionChange;
  backspace(): DocumentSessionChange;
  deleteSelection(): DocumentSessionChange;
  undo(): DocumentSessionChange;
  redo(): DocumentSessionChange;
  setSelection(anchorOffset: number, headOffset?: number): DocumentSessionChange;
  setLayoutMetrics(metrics: PosttextLayoutMetrics): DocumentSessionChange;
  setTokens(tokens: readonly EditorToken[]): DocumentSessionChange;
  getText(): string;
  getTokens(): readonly EditorToken[];
  getSelections(): SelectionSet<PieceTableAnchor>;
  getSnapshot(): PieceTableSnapshot;
  getLayout(): PosttextLayout;
  getLayoutSummary(): DocumentSessionLayoutSummary;
  getLayoutXY(offset: number): PosttextXY;
  getLayoutOffset(point: PosttextXY): number;
  getLayoutRangeBoxes(startOffset: number, endOffset: number): PosttextRangeBox[];
  queryLayoutViewport(viewport: PosttextViewport): PosttextViewportResult;
  canUndo(): boolean;
  canRedo(): boolean;
};

class PieceTableDocumentSession implements DocumentSession {
  private history: PieceTableEditorHistory;
  private layoutSession: PosttextLayoutSession;
  private text: string;
  private tokens: readonly EditorToken[] = [];

  public constructor(text: string) {
    const snapshot = createPieceTableSnapshot(text);
    const selections = createSelectionSet([createAnchorSelection(snapshot, snapshot.length)], true);
    this.history = createEditorHistory(snapshot, selections);
    this.layoutSession = createPosttextLayoutSession(snapshot);
    this.text = text;
  }

  public applyText(text: string): DocumentSessionChange {
    const start = nowMs();
    if (text.length === 0) {
      return appendTiming(this.createChange("none", []), "session.applyText", start);
    }

    const result = applyTextToSelections(this.history.current, this.history.selections, text);
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits),
      "session.applyText",
      start,
    );
  }

  public backspace(): DocumentSessionChange {
    const start = nowMs();
    const result = backspaceSelections(this.history.current, this.history.selections);
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits),
      "session.backspace",
      start,
    );
  }

  public deleteSelection(): DocumentSessionChange {
    const start = nowMs();
    const result = deleteSelections(this.history.current, this.history.selections);
    return appendTiming(
      this.commitEdit(result.snapshot, result.selections, result.edits),
      "session.delete",
      start,
    );
  }

  public undo(): DocumentSessionChange {
    const start = nowMs();
    const next = undoEditorHistory(this.history);
    if (next === this.history) {
      return appendTiming(this.createChange("none", []), "session.undo", start);
    }

    this.history = next;
    const layoutTimingStart = nowMs();
    const layoutMode = this.updateLayout(this.history.current, []);
    this.refreshText();
    const change = appendTiming(
      this.createChange("undo", [], layoutMode),
      layoutTimingName(layoutMode),
      layoutTimingStart,
    );
    return appendTiming(change, "session.undo", start);
  }

  public redo(): DocumentSessionChange {
    const start = nowMs();
    const next = redoEditorHistory(this.history);
    if (next === this.history) {
      return appendTiming(this.createChange("none", []), "session.redo", start);
    }

    this.history = next;
    const layoutTimingStart = nowMs();
    const layoutMode = this.updateLayout(this.history.current, []);
    this.refreshText();
    const change = appendTiming(
      this.createChange("redo", [], layoutMode),
      layoutTimingName(layoutMode),
      layoutTimingStart,
    );
    return appendTiming(change, "session.redo", start);
  }

  public setSelection(anchorOffset: number, headOffset = anchorOffset): DocumentSessionChange {
    const start = nowMs();
    const selection = createAnchorSelection(this.history.current, anchorOffset, headOffset);
    const selections = createSelectionSet([selection], true);
    this.history = { ...this.history, selections };
    return appendTiming(this.createChange("selection", []), "session.selection", start);
  }

  public setLayoutMetrics(metrics: PosttextLayoutMetrics): DocumentSessionChange {
    const start = nowMs();
    const result = setPosttextLayoutSessionMetrics(this.layoutSession, metrics);
    this.layoutSession = result.session;
    const change = appendTiming(
      this.createChange("none", [], result.mode),
      layoutTimingName(result.mode),
      start,
    );
    return appendTiming(change, "session.setLayoutMetrics", start);
  }

  public setTokens(tokens: readonly EditorToken[]): DocumentSessionChange {
    const start = nowMs();
    this.tokens = [...tokens];
    return appendTiming(this.createChange("none", []), "session.setTokens", start);
  }

  public getText(): string {
    return this.text;
  }

  public getTokens(): readonly EditorToken[] {
    return this.tokens;
  }

  public getSelections(): SelectionSet<PieceTableAnchor> {
    return this.history.selections;
  }

  public getSnapshot(): PieceTableSnapshot {
    return this.history.current;
  }

  public getLayout(): PosttextLayout {
    return this.layoutSession.layout;
  }

  public getLayoutSummary(): DocumentSessionLayoutSummary {
    return this.createLayoutSummary("reuse");
  }

  public getLayoutXY(offset: number): PosttextXY {
    return posttextOffsetToXY(this.layoutSession.layout, offset);
  }

  public getLayoutOffset(point: PosttextXY): number {
    return posttextXYToOffset(this.layoutSession.layout, point);
  }

  public getLayoutRangeBoxes(startOffset: number, endOffset: number): PosttextRangeBox[] {
    return getPosttextRangeBoxes(this.layoutSession.layout, startOffset, endOffset);
  }

  public queryLayoutViewport(viewport: PosttextViewport): PosttextViewportResult {
    return queryNoWrapPosttextViewport(this.layoutSession.layout, viewport);
  }

  public canUndo(): boolean {
    return this.history.undo !== null;
  }

  public canRedo(): boolean {
    return this.history.redo !== null;
  }

  private commitEdit(
    snapshot: PieceTableSnapshot,
    selections: SelectionSet<PieceTableAnchor>,
    edits: readonly TextEdit[],
  ): DocumentSessionChange {
    if (edits.length === 0) return this.createChange("none", []);

    this.history = commitEditorHistory(this.history, snapshot, selections);
    const layoutTimingStart = nowMs();
    const layoutMode = this.updateLayout(snapshot, edits);
    this.refreshText();
    return appendTiming(
      this.createChange("edit", edits, layoutMode),
      layoutTimingName(layoutMode),
      layoutTimingStart,
    );
  }

  private refreshText(): void {
    this.text = getPieceTableText(this.history.current);
  }

  private updateLayout(
    snapshot: PieceTableSnapshot,
    edits: readonly TextEdit[],
  ): PosttextLayoutUpdateMode {
    const result = updatePosttextLayoutSession(this.layoutSession, snapshot, edits);
    this.layoutSession = result.session;
    return result.mode;
  }

  private createChange(
    kind: DocumentSessionChangeKind,
    edits: readonly TextEdit[],
    layoutUpdateMode: PosttextLayoutUpdateMode = "reuse",
  ): DocumentSessionChange {
    return {
      kind,
      edits,
      snapshot: this.history.current,
      selections: this.history.selections,
      text: this.text,
      tokens: this.tokens,
      timings: [],
      layout: this.createLayoutSummary(layoutUpdateMode),
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
    };
  }

  private createLayoutSummary(updateMode: PosttextLayoutUpdateMode): DocumentSessionLayoutSummary {
    return {
      revision: this.layoutSession.stats.revision,
      updateMode,
      rebuildCount: this.layoutSession.stats.rebuildCount,
      incrementalUpdateCount: this.layoutSession.stats.incrementalUpdateCount,
      reuseCount: this.layoutSession.stats.reuseCount,
      lineCount: this.layoutSession.layout.lineIndex.lineCount,
      width: this.layoutSession.layout.width,
      height: this.layoutSession.layout.height,
    };
  }
}

export function createDocumentSession(text: string): DocumentSession {
  return new PieceTableDocumentSession(text);
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function appendTiming(
  change: DocumentSessionChange,
  name: string,
  startMs: number,
): DocumentSessionChange {
  return {
    ...change,
    timings: [...change.timings, { name, durationMs: nowMs() - startMs }],
  };
}

function layoutTimingName(mode: PosttextLayoutUpdateMode): string {
  return `posttext.layout.${mode}`;
}
