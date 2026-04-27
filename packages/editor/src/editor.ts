import type {
  DocumentSession,
  DocumentSessionChange,
  EditorTimingMeasurement,
} from "./documentSession";
import { createDocumentSession } from "./documentSession";
import type {
  PosttextLayoutMetrics,
  PosttextRangeBox,
  PosttextViewport,
  PosttextXY,
} from "./layout";
import { offsetToPoint } from "./pieceTable";
import { resolveSelection } from "./selections";
import {
  createEditorSyntaxSession,
  inferEditorSyntaxLanguage,
  type EditorSyntaxLanguageId,
  type EditorSyntaxResult,
  type EditorSyntaxSession,
  type EditorSyntaxSessionOptions,
} from "./syntax";
import type { EditorDocument, EditorToken, EditorTokenStyle, TextEdit } from "./tokens";
import { buildHighlightRule, clamp, normalizeTokenStyle, serializeTokenStyle } from "./style-utils";

let editorInstanceCount = 0;

type CaretPositionResult = {
  readonly offsetNode: Node;
  readonly offset: number;
};

type DocumentWithCaretHitTesting = Document & {
  readonly caretPositionFromPoint?: (x: number, y: number) => CaretPositionResult | null;
  readonly caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

type MouseSelectionDrag = {
  readonly anchorOffset: number;
  headOffset: number;
};

export type LiveLayoutQueryResult = {
  readonly revision: number;
  readonly caret: PosttextXY;
  readonly viewportLineCount: number;
  readonly selectionBoxCount: number;
};

type EditorBoxMetrics = {
  readonly paddingLeft: number;
  readonly paddingTop: number;
};

type ClippedRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export function resetEditorInstanceCount(): void {
  editorInstanceCount = 0;
}

/** Minimal interface for the CSS Custom Highlight API registry. */
export interface HighlightRegistry {
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
}

export type EditorSessionChangeHandler = (change: DocumentSessionChange) => void;

export type EditorSessionOptions = {
  readonly onChange?: EditorSessionChangeHandler;
};

export type EditorSyntaxStatus = "plain" | "loading" | "ready" | "error";

export type EditorState = {
  readonly documentId: string | null;
  readonly languageId: EditorSyntaxLanguageId | null;
  readonly syntaxStatus: EditorSyntaxStatus;
  readonly cursor: {
    readonly row: number;
    readonly column: number;
  };
  readonly length: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
};

export type EditorChangeHandler = (
  state: EditorState,
  change: DocumentSessionChange | null,
) => void;

export type EditorOptions = {
  readonly onChange?: EditorChangeHandler;
};

export type EditorOpenDocumentOptions = {
  readonly text: string;
  readonly documentId?: string;
  readonly languageId?: EditorSyntaxLanguageId | null;
};

export type EditorSyntaxSessionFactory = (
  options: EditorSyntaxSessionOptions,
) => EditorSyntaxSession;

let editorSyntaxSessionFactory: EditorSyntaxSessionFactory = createEditorSyntaxSession;

let highlightRegistry: HighlightRegistry | undefined;

/**
 * Override the HighlightRegistry used by all Editor instances.
 * Useful for testing environments where CSS.highlights is unavailable.
 * Pass `undefined` to revert to the default `CSS.highlights`.
 */
export function setHighlightRegistry(registry: HighlightRegistry | undefined): void {
  highlightRegistry = registry;
}

export function setEditorSyntaxSessionFactory(
  factory: EditorSyntaxSessionFactory | undefined,
): void {
  editorSyntaxSessionFactory = factory ?? createEditorSyntaxSession;
}

function getHighlightRegistry(): HighlightRegistry {
  return highlightRegistry ?? CSS.highlights;
}

export class Editor {
  private el: HTMLPreElement;
  private readonly textNode: Text;
  private readonly selectionOverlay: HTMLDivElement;
  private readonly options: EditorOptions;
  private readonly highlightPrefix: string;
  private readonly styleEl: HTMLStyleElement;
  private highlightNames: string[] = [];
  private nextGroupId = 0;
  private session: DocumentSession | null = null;
  private sessionOptions: EditorSessionOptions = {};
  private documentId: string | null = null;
  private languageId: EditorSyntaxLanguageId | null = null;
  private syntaxStatus: EditorSyntaxStatus = "plain";
  private syntaxSession: EditorSyntaxSession | null = null;
  private documentVersion = 0;
  private syntaxVersion = 0;
  private mouseSelectionDrag: MouseSelectionDrag | null = null;
  private useSessionSelectionForNextInput = false;
  private lastLayoutQuery: LiveLayoutQueryResult | null = null;
  private trackedTokens: Array<{ start: number; end: number; styleKey: string; range: Range }> = [];
  private groups = new Map<
    string,
    { name: string; highlight: Highlight; style: EditorTokenStyle }
  >();

  constructor(container: HTMLElement, options: EditorOptions = {}) {
    this.options = options;
    this.el = document.createElement("pre");
    this.el.className = "editor";
    this.selectionOverlay = document.createElement("div");
    this.selectionOverlay.className = "editor-selection-overlay";
    this.textNode = document.createTextNode("");
    this.highlightPrefix = `editor-token-${editorInstanceCount++}`;
    this.styleEl = document.createElement("style");

    this.el.appendChild(this.textNode);
    this.el.tabIndex = 0;
    this.el.spellcheck = false;
    document.head.appendChild(this.styleEl);
    container.appendChild(this.el);
    document.body.appendChild(this.selectionOverlay);
    this.rebuildStyleRules();
    this.installEditingHandlers();
  }

  setContent(text: string): void {
    this.clearHighlights();
    this.textNode.data = text;
  }

  setTokens(tokens: readonly EditorToken[]): void {
    this.clearHighlights();

    const textLength = this.textNode.length;
    if (textLength === 0 || tokens.length === 0) return;

    for (const token of tokens) this.addTokenHighlight(token, textLength);

    this.rebuildStyleRules();
  }

  applyEdit(edit: TextEdit, tokens: readonly EditorToken[]): void {
    const { from, to, text } = edit;
    const deleteCount = to - from;
    const delta = text.length - deleteCount;

    // Update text — browser auto-adjusts all live Range objects on this node
    this.textNode.replaceData(from, deleteCount, text);

    const newTextLength = this.textNode.length;
    const newEditEnd = from + text.length;

    // Remove tracked tokens that overlapped the old edit region
    const dirtyGroupKeys = new Set<string>();
    const kept: typeof this.trackedTokens = [];

    for (const tracked of this.trackedTokens) {
      if (tracked.start < to && tracked.end > from) {
        const group = this.groups.get(tracked.styleKey);
        if (group) group.highlight.delete(tracked.range);
        dirtyGroupKeys.add(tracked.styleKey);
      } else {
        if (tracked.start >= to) {
          tracked.start += delta;
          tracked.end += delta;
        }
        kept.push(tracked);
      }
    }

    this.trackedTokens = kept;

    // Add new tokens that cover the edited region
    for (const token of tokens) {
      const start = clamp(token.start, 0, newTextLength);
      const end = clamp(token.end, start, newTextLength);
      if (start === end || start >= newEditEnd || end <= from) continue;

      const styleKey = this.addTokenHighlight(token, newTextLength);
      if (styleKey) dirtyGroupKeys.add(styleKey);
    }

    // Remove groups that are now empty
    for (const key of dirtyGroupKeys) {
      const group = this.groups.get(key);
      if (group && group.highlight.size === 0) {
        getHighlightRegistry().delete(group.name);
        this.highlightNames = this.highlightNames.filter((n) => n !== group.name);
        this.groups.delete(key);
      }
    }

    this.rebuildStyleRules();
  }

  setDocument(document: EditorDocument): void {
    this.setContent(document.text);
    this.setTokens(document.tokens ?? []);
  }

  openDocument(document: EditorOpenDocumentOptions): void {
    const documentVersion = this.resetOwnedDocument(document);
    this.notifyChange(null);
    this.refreshSyntax(documentVersion, null);
  }

  clearDocument(): void {
    this.clear();
    this.notifyChange(null);
  }

  getState(): EditorState {
    const snapshot = this.session?.getSnapshot();
    const length = snapshot?.length ?? this.textNode.length;
    const selection = this.session?.getSelections().selections[0];
    const resolved = snapshot && selection ? resolveSelection(snapshot, selection) : null;
    const point = snapshot ? offsetToPoint(snapshot, resolved?.headOffset ?? length) : null;

    return {
      documentId: this.documentId,
      languageId: this.languageId,
      syntaxStatus: this.syntaxStatus,
      cursor: {
        row: point?.row ?? 0,
        column: point?.column ?? 0,
      },
      length,
      canUndo: this.session?.canUndo() ?? false,
      canRedo: this.session?.canRedo() ?? false,
    };
  }

  getText(): string {
    return this.session?.getText() ?? this.textNode.data;
  }

  getLastLayoutQuery(): LiveLayoutQueryResult | null {
    return this.lastLayoutQuery;
  }

  attachSession(session: DocumentSession, options: EditorSessionOptions = {}): void {
    this.documentVersion += 1;
    this.documentId = null;
    this.languageId = null;
    this.syntaxStatus = "plain";
    this.disposeSyntaxSession();
    this.session = session;
    this.sessionOptions = options;
    this.el.contentEditable = "plaintext-only";
    this.syncSessionLayoutMetrics();
    this.setDocument({ text: session.getText(), tokens: session.getTokens() });
    this.syncDomSelection();
  }

  detachSession(): void {
    this.session = null;
    this.sessionOptions = {};
    this.lastLayoutQuery = null;
    this.clearSelectionHighlight();
    this.el.removeAttribute("contenteditable");
  }

  clear(): void {
    this.documentVersion += 1;
    this.documentId = null;
    this.languageId = null;
    this.syntaxStatus = "plain";
    this.disposeSyntaxSession();
    this.detachSession();
    this.setContent("");
  }

  dispose(): void {
    this.uninstallEditingHandlers();
    this.disposeSyntaxSession();
    this.detachSession();
    this.clearHighlights();
    this.styleEl.remove();
    this.selectionOverlay.remove();
    this.el.remove();
  }

  private resetOwnedDocument(document: EditorOpenDocumentOptions): number {
    this.documentVersion += 1;
    const documentVersion = this.documentVersion;
    this.documentId = document.documentId ?? null;
    this.languageId =
      document.languageId === undefined
        ? inferEditorSyntaxLanguage(document.documentId)
        : document.languageId;
    this.syntaxStatus = this.languageId ? "loading" : "plain";
    this.disposeSyntaxSession();

    const session = createDocumentSession(document.text);
    session.setLayoutMetrics(this.readLayoutMetrics());
    const documentId = this.documentId ?? `${this.highlightPrefix}-${documentVersion}`;
    this.syntaxSession = this.languageId
      ? editorSyntaxSessionFactory({
          documentId,
          languageId: this.languageId,
          text: document.text,
        })
      : null;

    this.session = session;
    this.sessionOptions = {};
    this.el.contentEditable = "plaintext-only";
    this.setDocument({ text: session.getText(), tokens: [] });
    this.syncDomSelection();
    return documentVersion;
  }

  private syncSessionLayoutMetrics(): void {
    this.session?.setLayoutMetrics(this.readLayoutMetrics());
  }

  private readLayoutMetrics(): PosttextLayoutMetrics {
    const style = getComputedStyle(this.el);
    const fontSize = readCssPixels(style.fontSize) ?? 13;
    const lineHeight = readCssPixels(style.lineHeight) ?? fontSize * 1.4;
    const tabSize = readCssNumber(style.tabSize) ?? 4;
    const fontKey = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

    return {
      charWidth: this.measureCharacterWidth(style, fontSize),
      lineHeight,
      tabSize,
      fontKey,
    };
  }

  private measureCharacterWidth(style: CSSStyleDeclaration, fontSize: number): number {
    const canvas = this.el.ownerDocument.createElement("canvas");
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext("2d");
    } catch {
      return Math.max(1, fontSize * 0.62);
    }

    if (!context) return Math.max(1, fontSize * 0.62);

    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const width = context.measureText("M").width;
    if (Number.isFinite(width) && width > 0) return width;
    return Math.max(1, fontSize * 0.62);
  }

  private disposeSyntaxSession(): void {
    this.syntaxVersion += 1;
    this.syntaxSession?.dispose();
    this.syntaxSession = null;
  }

  private installEditingHandlers(): void {
    this.el.addEventListener("mousedown", this.handleMouseDown);
    this.el.addEventListener("beforeinput", this.handleBeforeInput);
    this.el.addEventListener("paste", this.handlePaste);
    this.el.addEventListener("keydown", this.handleKeyDown);
    this.el.addEventListener("keyup", this.syncSessionSelectionFromDom);
    this.el.addEventListener("mouseup", this.syncSessionSelectionFromDom);
    this.el.addEventListener("scroll", this.syncRenderedSelectionFromSession);
    this.el.ownerDocument.addEventListener("selectionchange", this.syncCustomSelectionFromDom);
    this.el.ownerDocument.defaultView?.addEventListener(
      "resize",
      this.syncRenderedSelectionFromSession,
    );
  }

  private uninstallEditingHandlers(): void {
    this.el.removeEventListener("mousedown", this.handleMouseDown);
    this.el.removeEventListener("beforeinput", this.handleBeforeInput);
    this.el.removeEventListener("paste", this.handlePaste);
    this.el.removeEventListener("keydown", this.handleKeyDown);
    this.el.removeEventListener("keyup", this.syncSessionSelectionFromDom);
    this.el.removeEventListener("mouseup", this.syncSessionSelectionFromDom);
    this.el.removeEventListener("scroll", this.syncRenderedSelectionFromSession);
    this.el.ownerDocument.removeEventListener("selectionchange", this.syncCustomSelectionFromDom);
    this.el.ownerDocument.defaultView?.removeEventListener(
      "resize",
      this.syncRenderedSelectionFromSession,
    );
    this.stopMouseSelectionDrag();
  }

  private handleMouseDown = (event: MouseEvent): void => {
    if (!this.session) return;
    if (event.detail >= 4) {
      this.selectFullDocument(event, "input.quadClick");
      return;
    }

    const offset = this.textOffsetFromMouseEvent(event);
    if (offset === null) return;

    if (event.detail === 3) {
      this.selectLineAtOffset(event, offset);
      return;
    }

    if (event.detail === 2) {
      this.selectWordAtOffset(event, offset);
      return;
    }

    this.startMouseSelectionDrag(event, offset);
  };

  private startMouseSelectionDrag(event: MouseEvent, offset: number): void {
    if (event.button !== 0) return;
    if (event.detail !== 1) return;

    event.preventDefault();
    this.el.focus({ preventScroll: true });
    this.mouseSelectionDrag = { anchorOffset: offset, headOffset: offset };
    this.syncCustomSelectionHighlight(offset, offset);
    this.el.ownerDocument.addEventListener("mousemove", this.updateMouseSelectionDrag);
    this.el.ownerDocument.addEventListener("mouseup", this.finishMouseSelectionDrag);
  }

  private updateMouseSelectionDrag = (event: MouseEvent): void => {
    if (!this.mouseSelectionDrag) return;
    if (!this.session) return;

    const offset = this.textOffsetFromMouseEvent(event);
    if (offset === null) return;

    event.preventDefault();
    this.mouseSelectionDrag.headOffset = offset;
    this.syncCustomSelectionHighlight(this.mouseSelectionDrag.anchorOffset, offset);
    this.session.setSelection(this.mouseSelectionDrag.anchorOffset, offset);
    this.useSessionSelectionForNextInput = this.mouseSelectionDrag.anchorOffset !== offset;
  };

  private finishMouseSelectionDrag = (event: MouseEvent): void => {
    const drag = this.mouseSelectionDrag;
    if (!drag || !this.session) {
      this.stopMouseSelectionDrag();
      return;
    }

    const offset = this.textOffsetFromMouseEvent(event) ?? drag.headOffset;
    event.preventDefault();
    this.stopMouseSelectionDrag();

    const start = nowMs();
    const change = this.session.setSelection(drag.anchorOffset, offset);
    const syncDomSelection = drag.anchorOffset === offset;
    if (!syncDomSelection) this.useSessionSelectionForNextInput = true;
    this.applySessionChange(change, "input.selection", start, { syncDomSelection });
  };

  private stopMouseSelectionDrag(): void {
    this.mouseSelectionDrag = null;
    this.el.ownerDocument.removeEventListener("mousemove", this.updateMouseSelectionDrag);
    this.el.ownerDocument.removeEventListener("mouseup", this.finishMouseSelectionDrag);
  }

  private selectFullDocument(event: MouseEvent, timingName: string): void {
    if (!this.session) return;

    const start = eventStartMs(event);
    event.preventDefault();
    const change = this.session.setSelection(0, this.session.getSnapshot().length);
    this.syncCustomSelectionHighlight(0, this.session.getSnapshot().length);
    this.useSessionSelectionForNextInput = true;
    this.applySessionChange(change, timingName, start, { syncDomSelection: false });
  }

  private selectLineAtOffset(event: MouseEvent, offset: number): void {
    if (!this.session) return;

    const range = lineRangeAtOffset(this.session.getText(), offset);
    this.selectRange(event, range, "input.tripleClick");
  }

  private selectWordAtOffset(event: MouseEvent, offset: number): void {
    if (!this.session) return;

    const range = wordRangeAtOffset(this.session.getText(), offset);
    if (range.start === range.end) return;

    this.selectRange(event, range, "input.doubleClick");
  }

  private selectRange(
    event: MouseEvent,
    range: { readonly start: number; readonly end: number },
    timingName: string,
  ): void {
    if (!this.session) return;

    const start = eventStartMs(event);
    event.preventDefault();
    const change = this.session.setSelection(range.start, range.end);
    this.syncCustomSelectionHighlight(range.start, range.end);
    this.useSessionSelectionForNextInput = true;
    this.applySessionChange(change, timingName, start, { syncDomSelection: false });
  }

  private handleBeforeInput = (event: InputEvent): void => {
    if (!this.session) return;

    const text = event.data ?? "";
    if (event.inputType !== "insertText" && event.inputType !== "insertLineBreak") return;

    const start = eventStartMs(event);
    const selectionChange = this.selectionChangeBeforeEdit();
    event.preventDefault();
    const inserted = event.inputType === "insertLineBreak" ? "\n" : text;
    this.applySessionChange(
      mergeChangeTimings(this.session.applyText(inserted), selectionChange),
      "input.beforeinput",
      start,
    );
  };

  private handlePaste = (event: ClipboardEvent): void => {
    if (!this.session) return;

    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text.length === 0) return;

    const start = eventStartMs(event);
    const selectionChange = this.selectionChangeBeforeEdit();
    event.preventDefault();
    this.applySessionChange(
      mergeChangeTimings(this.session.applyText(text), selectionChange),
      "input.paste",
      start,
    );
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.session) return;

    if (this.handleUndoRedo(event)) return;
    if (event.key === "Backspace") {
      const start = eventStartMs(event);
      const selectionChange = this.selectionChangeBeforeEdit();
      event.preventDefault();
      this.applySessionChange(
        mergeChangeTimings(this.session.backspace(), selectionChange),
        "input.backspace",
        start,
      );
      return;
    }

    if (event.key !== "Delete") return;

    const start = eventStartMs(event);
    const selectionChange = this.selectionChangeBeforeEdit();
    event.preventDefault();
    this.applySessionChange(
      mergeChangeTimings(this.session.deleteSelection(), selectionChange),
      "input.delete",
      start,
    );
  };

  private handleUndoRedo(event: KeyboardEvent): boolean {
    if (!this.session) return false;
    if (!isUndoRedoEvent(event)) return false;

    event.preventDefault();
    const start = eventStartMs(event);
    const change = event.shiftKey ? this.session.redo() : this.session.undo();
    this.applySessionChange(change, event.shiftKey ? "input.redo" : "input.undo", start);
    return true;
  }

  private syncSessionSelectionFromDom = (_event: Event): void => {
    if (!this.session) return;
    if (this.mouseSelectionDrag) return;

    const start = nowMs();
    const change = this.updateSessionSelectionFromDom();
    if (!change) return;

    this.useSessionSelectionForNextInput = false;
    const timedChange = appendTiming(change, "input.selection", start);
    this.sessionOptions.onChange?.(timedChange);
    this.notifyChangeWithTiming(timedChange);
  };

  private updateSessionSelectionFromDom(): DocumentSessionChange | null {
    if (!this.session) return null;

    const readStart = nowMs();
    const offsets = this.readDomSelectionOffsets();
    if (!offsets) return null;

    this.syncCustomSelectionHighlight(offsets.anchorOffset, offsets.headOffset);
    return appendTiming(
      this.session.setSelection(offsets.anchorOffset, offsets.headOffset),
      "editor.readDomSelection",
      readStart,
    );
  }

  private selectionChangeBeforeEdit(): DocumentSessionChange | null {
    if (!this.useSessionSelectionForNextInput) return this.updateSessionSelectionFromDom();

    this.useSessionSelectionForNextInput = false;
    return null;
  }

  private applySessionChange(
    change: DocumentSessionChange,
    totalName = "editor.change",
    totalStart = nowMs(),
    options: { readonly syncDomSelection?: boolean } = {},
  ): void {
    let timedChange = change;
    const renderStart = nowMs();
    this.renderSessionChange(change);
    timedChange = appendTiming(timedChange, "editor.render", renderStart);

    if (options.syncDomSelection !== false) {
      const selectionStart = nowMs();
      this.syncDomSelection();
      timedChange = appendTiming(timedChange, "editor.syncDomSelection", selectionStart);
    }
    timedChange = this.measureLiveLayoutQueries(timedChange);
    const finalChange = appendTiming(timedChange, totalName, totalStart);
    this.sessionOptions.onChange?.(finalChange);
    this.refreshSyntax(this.documentVersion, finalChange);
    this.notifyChangeWithTiming(finalChange);
  }

  private measureLiveLayoutQueries(change: DocumentSessionChange): DocumentSessionChange {
    if (!this.session) return change;

    const start = nowMs();
    this.lastLayoutQuery = this.queryLiveLayout(this.session);
    return appendTiming(change, "posttext.query.live", start);
  }

  private queryLiveLayout(session: DocumentSession): LiveLayoutQueryResult {
    const snapshot = session.getSnapshot();
    const selection = session.getSelections().selections[0];
    const resolved = selection ? resolveSelection(snapshot, selection) : null;
    const headOffset = resolved?.headOffset ?? snapshot.length;
    const selectionBoxes = resolved
      ? session.getLayoutRangeBoxes(resolved.startOffset, resolved.endOffset)
      : [];
    const viewport = session.queryLayoutViewport(this.currentLayoutViewport(session));

    return {
      revision: session.getLayoutSummary().revision,
      caret: session.getLayoutXY(headOffset),
      viewportLineCount: viewport.lines.length,
      selectionBoxCount: selectionBoxes.length,
    };
  }

  private currentLayoutViewport(session: DocumentSession): PosttextViewport {
    const lineHeight = session.getLayout().metrics.lineHeight;
    const x1 = this.el.scrollLeft;
    const y1 = this.el.scrollTop;
    const width = Math.max(this.el.clientWidth, 1);
    const height = Math.max(this.el.clientHeight, lineHeight);

    return {
      x1,
      y1,
      x2: x1 + width,
      y2: y1 + height,
    };
  }

  private renderSessionChange(change: DocumentSessionChange): void {
    const edit = change.edits[0];
    if (change.kind === "selection" || change.kind === "none") return;
    if (change.kind === "edit" && edit && change.edits.length === 1) {
      this.applyEdit(edit, []);
      return;
    }

    this.setDocument({ text: change.text, tokens: [] });
  }

  private notifyChange(change: DocumentSessionChange | null): void {
    this.options.onChange?.(this.getState(), change);
  }

  private notifyChangeWithTiming(change: DocumentSessionChange): void {
    const notifyStart = nowMs();
    const state = this.getState();
    const timedChange = appendTiming(change, "editor.notify", notifyStart);
    this.options.onChange?.(state, timedChange);
  }

  private refreshSyntax(documentVersion: number, change: DocumentSessionChange | null): void {
    if (!this.syntaxSession || !this.session || !this.languageId) return;
    if (change && (change.kind === "none" || change.kind === "selection")) return;

    const text = this.session.getText();
    const startedAt = nowMs();
    const syntaxVersion = ++this.syntaxVersion;
    this.syntaxStatus = "loading";

    void this.loadSyntaxResult(change, text)
      .then((result) => {
        this.applySyntaxResult(result, documentVersion, syntaxVersion, startedAt);
      })
      .catch(() => {
        this.applySyntaxError(documentVersion, syntaxVersion);
      });
  }

  private loadSyntaxResult(
    change: DocumentSessionChange | null,
    text: string,
  ): Promise<EditorSyntaxResult> {
    if (!this.syntaxSession) return Promise.reject(new Error("No syntax session"));
    if (!change) return this.syntaxSession.refresh(text);
    return this.syntaxSession.applyChange(change);
  }

  private applySyntaxResult(
    result: EditorSyntaxResult,
    documentVersion: number,
    syntaxVersion: number,
    startedAt: number,
  ): void {
    if (!this.session || documentVersion !== this.documentVersion) return;
    if (syntaxVersion !== this.syntaxVersion) return;

    this.syntaxStatus = "ready";
    const tokenChange = this.session.setTokens(result.tokens);
    const timedChange = appendTiming(tokenChange, "editor.syntax", startedAt);
    this.setTokens(result.tokens);
    this.notifyChange(timedChange);
  }

  private applySyntaxError(documentVersion: number, syntaxVersion: number): void {
    if (documentVersion !== this.documentVersion) return;
    if (syntaxVersion !== this.syntaxVersion) return;

    this.syntaxStatus = "error";
    this.notifyChange(null);
  }

  private syncDomSelection(): void {
    if (!this.session) return;

    const selection = this.session.getSelections().selections[0];
    if (!selection) return;

    const resolved = resolveSelection(this.session.getSnapshot(), selection);
    const start = clamp(resolved.startOffset, 0, this.textNode.length);
    const end = clamp(resolved.endOffset, start, this.textNode.length);
    const range = document.createRange();
    range.setStart(this.textNode, start);
    range.setEnd(this.textNode, end);

    const domSelection = window.getSelection();
    domSelection?.removeAllRanges();
    domSelection?.addRange(range);
    this.syncCustomSelectionHighlight(start, end);
  }

  private readDomSelectionOffsets(): { anchorOffset: number; headOffset: number } | null {
    const selection = window.getSelection();
    if (!selection?.anchorNode || !selection.focusNode) return null;

    const anchorOffset = this.domBoundaryToTextOffset(selection.anchorNode, selection.anchorOffset);
    const headOffset = this.domBoundaryToTextOffset(selection.focusNode, selection.focusOffset);
    if (anchorOffset === null || headOffset === null) return null;

    return { anchorOffset, headOffset };
  }

  private syncCustomSelectionFromDom = (): void => {
    if (!this.session) return;

    const offsets = this.readDomSelectionOffsets();
    if (!offsets) return;

    this.syncCustomSelectionHighlight(offsets.anchorOffset, offsets.headOffset);
  };

  private syncCustomSelectionHighlight(anchorOffset: number, headOffset: number): void {
    const start = clamp(Math.min(anchorOffset, headOffset), 0, this.textNode.length);
    const end = clamp(Math.max(anchorOffset, headOffset), start, this.textNode.length);
    if (start === end) {
      this.clearSelectionHighlight();
      return;
    }

    if (!this.session) return;

    const boxes = this.session.getLayoutRangeBoxes(start, end);
    this.renderSelectionBoxes(boxes);
  }

  private clearSelectionHighlight(): void {
    this.selectionOverlay.replaceChildren();
    this.selectionOverlay.hidden = true;
  }

  private syncRenderedSelectionFromSession = (): void => {
    if (!this.session) {
      this.clearSelectionHighlight();
      return;
    }

    const selection = this.session.getSelections().selections[0];
    if (!selection) {
      this.clearSelectionHighlight();
      return;
    }

    const resolved = resolveSelection(this.session.getSnapshot(), selection);
    this.syncCustomSelectionHighlight(resolved.startOffset, resolved.endOffset);
  };

  private renderSelectionBoxes(boxes: readonly PosttextRangeBox[]): void {
    const editorRect = this.el.getBoundingClientRect();
    const metrics = this.editorBoxMetrics();
    const overlayWidth = Math.max(
      editorRect.width,
      this.el.clientWidth,
      this.session?.getLayout().width ?? 1,
    );
    const overlayHeight = Math.max(
      editorRect.height,
      this.el.clientHeight,
      this.session?.getLayout().height ?? 1,
    );
    const fragments = boxes
      .map((box) => this.createSelectionFragment(box, overlayWidth, overlayHeight, metrics))
      .filter((fragment) => fragment !== null);

    this.selectionOverlay.hidden = fragments.length === 0;
    this.selectionOverlay.style.left = `${editorRect.left}px`;
    this.selectionOverlay.style.top = `${editorRect.top}px`;
    this.selectionOverlay.style.width = `${overlayWidth}px`;
    this.selectionOverlay.style.height = `${overlayHeight}px`;
    this.selectionOverlay.replaceChildren(...fragments);
  }

  private createSelectionFragment(
    box: PosttextRangeBox,
    overlayWidth: number,
    overlayHeight: number,
    metrics: EditorBoxMetrics,
  ): HTMLDivElement | null {
    const x = metrics.paddingLeft + box.rect.x - this.el.scrollLeft;
    const y = metrics.paddingTop + box.rect.y - this.el.scrollTop;
    const clipped = clipRect(x, y, box.rect.width, box.rect.height, overlayWidth, overlayHeight);
    if (!clipped) return null;

    const fragment = this.el.ownerDocument.createElement("div");
    fragment.className = "editor-selection-box";
    fragment.style.left = `${clipped.x}px`;
    fragment.style.top = `${clipped.y}px`;
    fragment.style.width = `${clipped.width}px`;
    fragment.style.height = `${clipped.height}px`;
    return fragment;
  }

  private editorBoxMetrics(): EditorBoxMetrics {
    const style = getComputedStyle(this.el);
    return {
      paddingLeft: readCssPixels(style.paddingLeft) ?? 0,
      paddingTop: readCssPixels(style.paddingTop) ?? 0,
    };
  }

  private domBoundaryToTextOffset(node: Node, offset: number): number | null {
    if (node === this.textNode) return clamp(offset, 0, this.textNode.length);
    if (node === this.el) return elementBoundaryToTextOffset(offset, this.textNode.length);
    if (this.el.contains(node)) return this.internalBoundaryToTextOffset(node, offset);
    return this.externalBoundaryToTextOffset(node, offset);
  }

  private textOffsetFromMouseEvent(event: MouseEvent): number | null {
    const documentWithCaret = this.el.ownerDocument as DocumentWithCaretHitTesting;
    const position = documentWithCaret.caretPositionFromPoint?.(event.clientX, event.clientY);
    if (position) return this.domBoundaryToTextOffset(position.offsetNode, position.offset);

    const range = documentWithCaret.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (range) return this.domBoundaryToTextOffset(range.startContainer, range.startOffset);

    return null;
  }

  private internalBoundaryToTextOffset(node: Node, offset: number): number | null {
    if (!node.contains(this.textNode)) return null;

    const child = childContainingNode(node, this.textNode);
    const childIndex = child ? childNodeIndex(node, child) : -1;
    if (childIndex === -1) return null;

    return elementBoundaryToTextOffset(offset <= childIndex ? 0 : 1, this.textNode.length);
  }

  private externalBoundaryToTextOffset(node: Node, offset: number): number | null {
    if (node.contains(this.el)) {
      const child = childContainingNode(node, this.el);
      const childIndex = child ? childNodeIndex(node, child) : -1;
      if (childIndex === -1) return null;
      return elementBoundaryToTextOffset(offset <= childIndex ? 0 : 1, this.textNode.length);
    }

    const position = node.compareDocumentPosition(this.el);
    if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return 0;
    if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return this.textNode.length;
    return null;
  }

  private addTokenHighlight(token: EditorToken, textLength: number): string | null {
    const start = clamp(token.start, 0, textLength);
    const end = clamp(token.end, start, textLength);
    if (start === end) return null;

    const style = normalizeTokenStyle(token.style);
    if (!style) return null;

    const styleKey = serializeTokenStyle(style);

    if (!this.groups.has(styleKey)) {
      const name = `${this.highlightPrefix}-${this.nextGroupId++}`;
      this.groups.set(styleKey, { name, highlight: new Highlight(), style });
      getHighlightRegistry().set(name, this.groups.get(styleKey)!.highlight);
      this.highlightNames.push(name);
    }

    const group = this.groups.get(styleKey)!;
    const range = document.createRange();
    range.setStart(this.textNode, start);
    range.setEnd(this.textNode, end);
    group.highlight.add(range);
    this.trackedTokens.push({ start, end, styleKey, range });
    return styleKey;
  }

  private clearHighlights() {
    for (const name of this.highlightNames) getHighlightRegistry().delete(name);

    this.highlightNames = [];
    this.trackedTokens = [];
    this.groups.clear();
    this.nextGroupId = 0;
    this.rebuildStyleRules();
  }

  private rebuildStyleRules() {
    const rules: string[] = [];
    for (const { name, style } of this.groups.values()) rules.push(buildHighlightRule(name, style));
    this.styleEl.textContent = rules.join("\n");
  }
}

function isUndoRedoEvent(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== "z") return false;
  return event.metaKey || event.ctrlKey;
}

function elementBoundaryToTextOffset(offset: number, textLength: number): number {
  if (offset <= 0) return 0;
  return textLength;
}

function childContainingNode(ancestor: Node, node: Node): ChildNode | null {
  for (const child of ancestor.childNodes) {
    if (child === node || child.contains(node)) return child;
  }

  return null;
}

function childNodeIndex(parent: Node, child: ChildNode): number {
  return Array.prototype.indexOf.call(parent.childNodes, child) as number;
}

function lineRangeAtOffset(text: string, rawOffset: number): { start: number; end: number } {
  const offset = clamp(rawOffset, 0, text.length);
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const nextLineBreak = text.indexOf("\n", offset);
  const lineEnd = nextLineBreak === -1 ? text.length : nextLineBreak;
  return { start: lineStart, end: lineEnd };
}

function wordRangeAtOffset(text: string, rawOffset: number): { start: number; end: number } {
  const offset = clamp(rawOffset, 0, text.length);
  const probeOffset = wordProbeOffset(text, offset);
  if (probeOffset === null) return { start: offset, end: offset };

  let start = probeOffset;
  let end = probeOffset + codePointSizeAt(text, probeOffset);

  while (start > 0) {
    const previous = previousCodePointStart(text, start);
    if (previous === null || !isWordCodePointAt(text, previous)) break;
    start = previous;
  }

  while (end < text.length && isWordCodePointAt(text, end)) end += codePointSizeAt(text, end);

  return { start, end };
}

function wordProbeOffset(text: string, offset: number): number | null {
  if (offset < text.length && isWordCodePointAt(text, offset)) return offset;

  const previous = previousCodePointStart(text, offset);
  if (previous !== null && isWordCodePointAt(text, previous)) return previous;

  return null;
}

function isWordCodePointAt(text: string, offset: number): boolean {
  const codePoint = text.codePointAt(offset);
  if (codePoint === undefined) return false;
  return /^[\p{L}\p{N}_]$/u.test(String.fromCodePoint(codePoint));
}

function previousCodePointStart(text: string, offset: number): number | null {
  if (offset <= 0) return null;

  const previous = offset - 1;
  const codeUnit = text.charCodeAt(previous);
  const beforePrevious = previous - 1;
  const isLowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
  if (!isLowSurrogate || beforePrevious < 0) return previous;

  const previousCodeUnit = text.charCodeAt(beforePrevious);
  const isHighSurrogate = previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff;
  return isHighSurrogate ? beforePrevious : previous;
}

function codePointSizeAt(text: string, offset: number): number {
  const codePoint = text.codePointAt(offset);
  if (codePoint === undefined) return 0;
  return codePoint > 0xffff ? 2 : 1;
}

function readCssPixels(value: string): number | null {
  if (!value.endsWith("px")) return null;

  const parsed = Number.parseFloat(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return null;
}

function readCssNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return null;
}

function clipRect(
  x: number,
  y: number,
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): ClippedRect | null {
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(maxWidth, x + width);
  const bottom = Math.min(maxHeight, y + height);
  if (right <= left || bottom <= top) return null;

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function eventStartMs(event: Event): number {
  const start = event.timeStamp;
  if (!Number.isFinite(start) || start <= 0) return nowMs();

  const now = nowMs();
  if (start <= now + 1_000) return start;

  const wallClockDelta = Date.now() - start;
  if (!Number.isFinite(wallClockDelta) || wallClockDelta < 0) return now;

  return Math.max(0, now - wallClockDelta);
}

function appendTiming(
  change: DocumentSessionChange,
  name: string,
  startMs: number,
): DocumentSessionChange {
  return {
    ...change,
    timings: [...change.timings, createTiming(name, startMs)],
  };
}

function mergeChangeTimings(
  change: DocumentSessionChange,
  earlierChange: DocumentSessionChange | null,
): DocumentSessionChange {
  if (!earlierChange) return change;
  return {
    ...change,
    timings: [...earlierChange.timings, ...change.timings],
  };
}

function createTiming(name: string, startMs: number): EditorTimingMeasurement {
  return { name, durationMs: nowMs() - startMs };
}
