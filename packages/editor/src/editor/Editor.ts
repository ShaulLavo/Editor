import type { DocumentSession, DocumentSessionChange } from "../documentSession";
import { createDocumentSession, createStaticDocumentSession } from "../documentSession";
import { childContainingNode, childNodeIndex, elementBoundaryToTextOffset } from "./domBoundary";
import { projectSyntaxFoldsThroughLineEdit } from "./folds";
import { EditorFoldState } from "./foldState";
import { keyboardFallbackText } from "./input";
import { EditorKeymapController } from "./keymap";
import { editActionForCommand, isEditorEditActionCommand } from "./editActions";
import { LatestAsyncRequest } from "./latestAsyncRequest";
import {
  cancelFrame,
  mouseSelectionAutoScrollDelta,
  requestFrame,
  type MouseSelectionDrag,
} from "./mouseSelection";
import { lineRangeAtOffset, wordRangeAtOffset } from "./textRanges";
import { appendTiming, eventStartMs, mergeChangeTimings, nowMs } from "./timing";
import { copyTokenProjectionMetadata, projectTokensThroughEdit } from "./tokenProjection";
import type { EditorCommandContext, EditorCommandId } from "./commands";
import { normalizeEditorEditInput } from "./editInput";
import { navigationTargetForCommand } from "./navigationTargets";
import {
  getEditorSyntaxSessionFactory,
  getHighlightRegistry,
  nextEditorHighlightPrefix,
  observeEditorMountTiming,
  recordEditorMountTiming,
  resetEditorInstanceCount,
  setEditorSyntaxSessionFactory,
  setHighlightRegistry,
} from "./runtime";
import {
  DOCUMENT_START_SCROLL_POSITION,
  normalizeScrollOffset,
  preservedScrollPosition,
} from "./scroll";
import type {
  EditorDocumentMode,
  EditorEditInput,
  EditorEditOptions,
  EditorEditability,
  EditorOptions,
  EditorOpenDocumentOptions,
  EditorRangeDecoration,
  EditorScrollPosition,
  EditorSetTextOptions,
  EditorSessionOptions,
  EditorState,
  EditorSyntaxStatus,
} from "./types";
import { EditorViewContributionController } from "./viewContributions";
import type { FoldMap } from "../foldMap";
import { normalizeTabSize } from "../displayTransforms";
import { offsetToPoint } from "../pieceTable/positions";
import { getPieceTableText } from "../pieceTable/reads";
import {
  EditorPluginHost,
  type EditorCommandHandler,
  type EditorDisposable,
  type EditorFeatureContribution,
  type EditorFeatureContributionContext,
  type EditorFeatureContributionProvider,
  type EditorGutterContribution,
  type EditorHighlightResult,
  type EditorHighlighterSession,
  type EditorOverlaySide,
  type EditorPlugin,
  type EditorResolvedSelection,
  type EditorSelectionRange,
  type EditorViewContribution,
  type EditorViewContributionContext,
  type EditorViewContributionProvider,
  type EditorViewContributionUpdateKind,
  type EditorViewSnapshot,
} from "../plugins";
import {
  SelectionGoal,
  resolveSelection,
  type ResolvedSelection,
  type SelectionGoal as SelectionGoalValue,
} from "../selections";
import {
  type EditorSyntaxLanguageId,
  type EditorSyntaxResult,
  type EditorSyntaxSession,
} from "../syntax/session";
import {
  parseMergeConflicts,
  resolveMergeConflict as resolveMergeConflictText,
  type MergeConflictRegion,
  type MergeConflictResolution,
} from "../mergeConflicts";
import type { FoldRange } from "../syntax/session";
import type { EditorTheme } from "../theme";
import { editorThemesEqual, mergeEditorThemes } from "../theme";
import type { EditorDocument, EditorToken, TextEdit } from "../tokens";
import { clamp } from "../style-utils";
import {
  VirtualizedTextView,
  type HiddenCharactersMode,
  type VirtualizedFoldMarker,
  type VirtualizedTextRowDecoration,
} from "../virtualization/virtualizedTextView";

const SYNTAX_EDIT_DEBOUNCE_MS = 75;
export {
  observeEditorMountTiming,
  resetEditorInstanceCount,
  setEditorSyntaxSessionFactory,
  setHighlightRegistry,
};

const syntaxRefreshDelay = (change: DocumentSessionChange | null): number => {
  if (!change || change.edits.length === 0) return 0;
  return SYNTAX_EDIT_DEBOUNCE_MS;
};

const selectionRevealOffset = (
  reveal: EditorSelectionRevealTarget | undefined,
  fallback: number | undefined,
): number | undefined => {
  if (typeof reveal === "number") return reveal;
  if (reveal?.reveal === false) return undefined;

  return reveal?.revealOffset ?? fallback;
};

type SessionChangeOptions = {
  readonly syncDomSelection?: boolean;
  readonly revealOffset?: number;
  readonly revealBlock?: "nearest" | "end";
};

export type EditorSelectionRevealOptions = {
  readonly reveal?: boolean;
  readonly revealOffset?: number;
};

export type EditorSelectionRevealTarget = number | EditorSelectionRevealOptions;

type ResetOwnedDocumentOptions = {
  readonly documentId: string | null;
  readonly persistentIdentity: boolean;
  readonly scrollPosition?: EditorScrollPosition;
};

type RangeDecorationGroup = {
  readonly name: string;
  readonly ranges: EditorRangeDecoration[];
  readonly style: ReturnType<typeof rangeDecorationStyle>;
};

type PendingRangeDecorationGroup = RangeDecorationGroup & {
  readonly key: string;
};

const EDITOR_FIND_FEATURE_ID = "editor.find";
const DEFAULT_EDITABILITY: EditorEditability = "editable";
const DEFAULT_DOCUMENT_MODE: EditorDocumentMode = "session";

type EditorFindFeature = {
  openFind(): boolean;
  openFindReplace(): boolean;
  closeFind(): boolean;
  findNext(): boolean;
  findPrevious(): boolean;
  replaceOne(): boolean;
  replaceAll(): boolean;
  selectAllMatches(): boolean;
};

type FoldOperation = "fold" | "unfold" | "toggle";

export class Editor {
  private readonly container: HTMLElement;
  private readonly view: VirtualizedTextView;
  private readonly foldState: EditorFoldState;
  private readonly el: HTMLDivElement;
  private readonly options: EditorOptions;
  private readonly pluginHost: EditorPluginHost;
  private readonly commandHandlers = new Map<EditorCommandId, EditorCommandHandler>();
  private readonly editorFeatures = new Map<string, unknown>();
  private readonly editorFeatureContributions: EditorFeatureContribution[] = [];
  private readonly viewContributionsByProvider = new Map<
    EditorViewContributionProvider,
    EditorViewContribution
  >();
  private readonly editorFeatureContributionsByProvider = new Map<
    EditorFeatureContributionProvider,
    EditorFeatureContribution
  >();
  private readonly keymap: EditorKeymapController;
  private readonly viewContributions: EditorViewContributionController;
  private readonly highlightPrefix: string;
  private text = "";
  private session: DocumentSession | null = null;
  private sessionOptions: EditorSessionOptions = {};
  private documentId: string | null = null;
  private documentMode: EditorDocumentMode = DEFAULT_DOCUMENT_MODE;
  private editability: EditorEditability = DEFAULT_EDITABILITY;
  private languageId: EditorSyntaxLanguageId | null = null;
  private syntaxStatus: EditorSyntaxStatus = "plain";
  private syntaxSession: EditorSyntaxSession | null = null;
  private highlighterSession: EditorHighlighterSession | null = null;
  private configuredTheme: EditorTheme | null = null;
  private providerHighlighterTheme: EditorTheme | null = null;
  private highlighterTheme: EditorTheme | null = null;
  private readonly syntaxRequests = new LatestAsyncRequest<EditorSyntaxResult>();
  private readonly highlightRequests = new LatestAsyncRequest<EditorHighlightResult>();
  private readonly highlighterThemeRequests = new LatestAsyncRequest<
    EditorTheme | null | undefined
  >();
  private tokens: readonly EditorToken[] = [];
  private documentVersion = 0;
  private mouseSelectionDrag: MouseSelectionDrag | null = null;
  private mouseSelectionAutoScrollFrame = 0;
  private useSessionSelectionForNextInput = false;
  private nativeInputGeneration = 0;
  private rangeDecorations: readonly EditorRangeDecoration[] = [];
  private appliedRangeDecorationNames: readonly string[] = [];
  private nativeInputHandlersInstalled = false;
  private readonly tabSize: number;

  constructor(container: HTMLElement, options: EditorOptions = {}) {
    const mountStart = nowMs();
    this.container = container;
    this.options = options;
    this.tabSize = normalizeTabSize(options.tabSize);
    this.editability = normalizeEditorEditability(options.editability);
    this.documentMode = normalizeEditorDocumentMode(options.documentMode);
    this.configuredTheme = options.theme ?? null;
    this.pluginHost = new EditorPluginHost(options.plugins);
    this.highlightPrefix = nextEditorHighlightPrefix();
    this.view = new VirtualizedTextView(container, {
      className: "editor",
      highlightRegistry: getHighlightRegistry(),
      gutterContributions: [...this.pluginHost.getGutterContributions()],
      cursorLineHighlight: options.cursorLineHighlight,
      hiddenCharacters: options.hiddenCharacters,
      lineHeight: options.lineHeight,
      rowGap: options.rowGap,
      tabSize: this.tabSize,
      textMetrics: options.textMetrics,
      onFoldToggle: this.handleFoldToggle,
      onViewportChange: this.handleViewportChange,
      selectionHighlightName: `${this.highlightPrefix}-selection`,
    });
    this.foldState = new EditorFoldState(this.view, () => this.session?.getSnapshot() ?? null);
    this.el = this.view.scrollElement;
    this.applyResolvedTheme();
    if (this.pluginHost.hasHighlighterProviders()) this.refreshHighlighterTheme();
    this.createInitialEditorFeatureContributions(
      this.pluginHost.getEditorFeatureContributionProviders(),
    );
    this.keymap = new EditorKeymapController({
      target: this.el,
      keymap: options.keymap,
      dispatch: (command, context) => this.dispatchCommand(command, context),
    });
    this.viewContributions = new EditorViewContributionController(
      this.createInitialViewContributions(this.pluginHost.getViewContributionProviders()),
      () => this.createViewSnapshot(),
    );
    this.pluginHost.setEvents({
      onHighlighterProvidersChanged: () => this.handleHighlighterProvidersChanged(),
      onSyntaxProvidersChanged: () => this.reloadSyntaxSession(),
      onViewContributionProviderAdded: (provider) => this.addViewContributionProvider(provider),
      onViewContributionProviderRemoved: (provider) =>
        this.removeViewContributionProvider(provider),
      onEditorFeatureContributionProviderAdded: (provider) =>
        this.addEditorFeatureContributionProvider(provider),
      onEditorFeatureContributionProviderRemoved: (provider) =>
        this.removeEditorFeatureContributionProvider(provider),
      onGutterContributionsChanged: () => this.syncGutterContributions(),
    });
    this.installEditingHandlers();
    this.initializeDefaultText();
    this.setRangeDecorations(options.rangeDecorations ?? []);
    recordEditorMountTiming(nowMs() - mountStart);
  }

  setContent(text: string): void {
    this.text = text;
    this.view.setText(text);
    this.setTokens([]);
    this.clearSyntaxFolds();
    this.applyRangeDecorations();
    this.notifyViewContributions("content", null);
  }

  setTokens(tokens: readonly EditorToken[]): void {
    const copiedTokens = [...tokens];
    copyTokenProjectionMetadata(tokens, copiedTokens);
    this.adoptTokens(copiedTokens);
  }

  applyEdit(edit: TextEdit, tokens: readonly EditorToken[]): void {
    const { from, to, text } = edit;
    this.text = `${this.text.slice(0, from)}${text}${this.text.slice(to)}`;
    this.view.applyEdit(edit, this.text);
    this.setTokens(tokens);
  }

  setDocument(document: EditorDocument): void {
    this.setContent(document.text);
    this.setTokens(document.tokens ?? []);
  }

  setFoldMap(foldMap: FoldMap | null): void {
    this.view.setFoldMap(foldMap);
  }

  setSyntaxFolds(folds: readonly FoldRange[]): void {
    this.foldState.setSyntaxFolds(folds);
  }

  toggleFold(offset?: number): boolean {
    return this.applyFoldOperation("toggle", offset);
  }

  fold(offset?: number): boolean {
    return this.applyFoldOperation("fold", offset);
  }

  unfold(offset?: number): boolean {
    return this.applyFoldOperation("unfold", offset);
  }

  foldAll(): boolean {
    if (!this.session) return false;

    const changed = this.foldState.foldAll();
    if (changed) this.notifyViewContributions("layout", null);
    return changed;
  }

  unfoldAll(): boolean {
    if (!this.session) return false;

    const changed = this.foldState.unfoldAll();
    if (changed) this.notifyViewContributions("layout", null);
    return changed;
  }

  setText(text: string, options: EditorSetTextOptions = {}): void {
    const currentScrollPosition = this.getScrollPosition();
    const documentVersion = this.resetOwnedDocument(
      {
        text,
        documentMode: options.documentMode ?? this.documentMode,
        languageId: options.languageId,
      },
      {
        documentId: null,
        persistentIdentity: false,
        scrollPosition: preservedScrollPosition(currentScrollPosition, options.scrollPosition),
      },
    );
    this.notifyChange(null);
    this.refreshSyntax(documentVersion, null);
  }

  syncText(text: string, options: EditorSetTextOptions = {}): void {
    const documentMode = normalizeEditorDocumentMode(options.documentMode ?? this.documentMode);
    const languageId = options.languageId ?? null;
    if (!this.session || documentMode !== this.documentMode || languageId !== this.languageId) {
      this.setText(text, options);
      return;
    }
    if (this.getText() === text) return;

    const scrollPosition = preservedScrollPosition(
      this.getScrollPosition(),
      options.scrollPosition,
    );
    const change = this.session.applyEdits([syncTextEdit(this.text, text)], {
      history: "skip",
    });
    if (change.kind === "none") return;

    this.applySessionChange(change, "editor.syncText", nowMs(), {
      syncDomSelection: false,
    });
    this.applyDocumentScrollPosition(scrollPosition);
  }

  edit(editOrEdits: EditorEditInput, options: EditorEditOptions = {}): void {
    if (!this.canEditDocument()) return;

    this.ensureAnonymousSession();
    if (!this.session) return;

    const edits = normalizeEditorEditInput(editOrEdits);
    const change = this.session.applyEdits(edits, options);
    if (change.kind === "none") return;

    this.applySessionChange(change, "editor.edit", nowMs());
  }

  openDocument(document: EditorOpenDocumentOptions): void {
    const documentVersion = this.resetOwnedDocument(document, {
      documentId: document.documentId ?? null,
      persistentIdentity: true,
      scrollPosition: document.scrollPosition,
    });
    this.notifyChange(null);
    this.refreshSyntax(documentVersion, null);
  }

  private ensureAnonymousSession(): void {
    if (this.session) return;

    this.resetOwnedDocument(
      { text: "", languageId: null },
      {
        documentId: null,
        persistentIdentity: false,
        scrollPosition: DOCUMENT_START_SCROLL_POSITION,
      },
    );
  }

  clearDocument(): void {
    this.clear();
    this.notifyChange(null);
  }

  getState(): EditorState {
    const snapshot = this.session?.getSnapshot();
    const length = snapshot?.length ?? this.text.length;
    const selection = this.session?.getSelections().selections[0];
    const resolved = snapshot && selection ? resolveSelection(snapshot, selection) : null;
    const point = snapshot ? offsetToPoint(snapshot, resolved?.headOffset ?? length) : null;

    return {
      documentId: this.documentId,
      documentMode: this.documentMode,
      editability: this.editability,
      languageId: this.languageId,
      syntaxStatus: this.syntaxStatus,
      cursor: {
        row: point?.row ?? 0,
        column: point?.column ?? 0,
      },
      length,
      canUndo: this.session?.canUndo() ?? false,
      canRedo: this.session?.canRedo() ?? false,
      isDirty: this.session?.isDirty() ?? false,
    };
  }

  getText(): string {
    return this.session?.getText() ?? this.text;
  }

  getMergeConflicts(): readonly MergeConflictRegion[] {
    return parseMergeConflicts(this.getText());
  }

  resolveMergeConflict(index: number, resolution: MergeConflictResolution): boolean {
    if (!this.canEditDocument()) return false;

    const text = this.getText();
    const conflict = parseMergeConflicts(text)[index];
    if (!conflict) return false;

    const resolved = resolveMergeConflictText(text, conflict, resolution);
    if (!resolved) return false;

    this.edit(
      { from: resolved.range.start, to: resolved.range.end, text: resolved.replacement },
      {
        selection: {
          anchor: resolved.selection.start,
          head: resolved.selection.end,
        },
      },
    );
    return true;
  }

  revealMergeConflict(index: number): boolean {
    const conflict = parseMergeConflicts(this.getText())[index];
    if (!conflict) return false;

    this.setSelection(conflict.range.start);
    return true;
  }

  focus(): void {
    this.view.focusInput();
  }

  setSelection(anchor: number, head = anchor, reveal?: EditorSelectionRevealTarget): void {
    const revealOffset = selectionRevealOffset(reveal, head);
    this.applyFindSelection(anchor, head, "editor.setSelection", revealOffset);
  }

  openFind(): boolean {
    return this.findFeature()?.openFind() ?? false;
  }

  openFindReplace(): boolean {
    return this.findFeature()?.openFindReplace() ?? false;
  }

  closeFind(): boolean {
    return this.findFeature()?.closeFind() ?? false;
  }

  findNext(): boolean {
    return this.findFeature()?.findNext() ?? false;
  }

  findPrevious(): boolean {
    return this.findFeature()?.findPrevious() ?? false;
  }

  replaceOne(): boolean {
    return this.findFeature()?.replaceOne() ?? false;
  }

  replaceAll(): boolean {
    return this.findFeature()?.replaceAll() ?? false;
  }

  selectAllMatches(): boolean {
    return this.findFeature()?.selectAllMatches() ?? false;
  }

  getScrollPosition(): Required<EditorScrollPosition> {
    const viewState = this.view.getState();
    return {
      top: viewState.scrollTop,
      left: viewState.scrollLeft,
    };
  }

  setScrollPosition(scrollPosition: EditorScrollPosition): void {
    this.applyScrollPosition(scrollPosition);
  }

  setTheme(theme: EditorTheme | null | undefined): void {
    const nextTheme = theme ?? null;
    if (editorThemesEqual(this.configuredTheme, nextTheme)) return;

    this.configuredTheme = nextTheme;
    this.applyResolvedTheme();
    this.reloadHighlighterSession();
    this.notifyViewContributions("tokens", null);
  }

  setHiddenCharacters(mode: HiddenCharactersMode): void {
    this.view.setHiddenCharacters(mode);
  }

  setKeymap(keymap: EditorOptions["keymap"]): void {
    this.keymap.setKeymap(keymap);
  }

  setEditability(editability: EditorEditability): void {
    const next = normalizeEditorEditability(editability);
    if (this.editability === next) return;

    this.editability = next;
    this.syncViewEditability();
    this.notifyChange(null);
  }

  setRangeDecorations(decorations: readonly EditorRangeDecoration[]): void {
    if (sameEditorRangeDecorations(this.rangeDecorations, decorations)) return;

    this.rangeDecorations = [...decorations];
    this.applyRangeDecorations();
  }

  setRowDecorations(decorations: ReadonlyMap<number, VirtualizedTextRowDecoration>): void {
    this.view.setRowDecorations(decorations);
    this.notifyViewContributions("layout", null);
  }

  setLineHeight(lineHeight: number): void {
    if (!this.view.setLineHeight(lineHeight)) return;

    this.notifyViewContributions("layout", null);
  }

  setRowGap(rowGap: number): void {
    if (!this.view.setRowGap(rowGap)) return;

    this.notifyViewContributions("layout", null);
  }

  addPlugin(plugin: EditorPlugin): EditorDisposable {
    return this.pluginHost.addPlugin(plugin);
  }

  removePlugin(plugin: EditorPlugin): boolean {
    return this.pluginHost.removePlugin(plugin);
  }

  setPlugins(plugins: readonly EditorPlugin[]): void {
    this.pluginHost.setPlugins(plugins);
  }

  dispatchCommand(command: EditorCommandId, context: EditorCommandContext = {}): boolean {
    const registeredResult = this.runRegisteredCommand(command, context);
    if (registeredResult !== null) {
      if (command === "closeFind" && !registeredResult)
        return this.applyClearSecondarySelections(context);
      return registeredResult;
    }
    if (command === "undo") return this.applyHistoryCommand("undo", context);
    if (command === "redo") return this.applyHistoryCommand("redo", context);
    if (command === "selectAll") return this.applySelectAllCommand(context);
    if (command === "addNextOccurrence") return this.applyAddNextOccurrenceCommand(context);
    if (command === "clearSecondarySelections") return this.applyClearSecondarySelections(context);
    if (command === "editor.action.insertCursorAbove")
      return this.applyInsertCursorCommand("above", context);
    if (command === "editor.action.insertCursorBelow")
      return this.applyInsertCursorCommand("below", context);
    if (command === "editor.action.selectHighlights" || command === "editor.action.changeAll")
      return this.applySelectExactOccurrencesCommand(command, context);
    if (command === "editor.action.moveSelectionToNextFindMatch")
      return this.applyMoveSelectionToNextOccurrenceCommand(context);
    if (command === "deleteBackward") return this.applyDeleteCommand("backward", context);
    if (command === "deleteForward") return this.applyDeleteCommand("forward", context);
    if (isEditorEditActionCommand(command)) return this.applyEditActionCommand(command, context);
    if (command === "indentSelection") return this.applyIndentCommand("indent", context);
    if (command === "outdentSelection") return this.applyIndentCommand("outdent", context);
    return this.applyNavigationCommand(command, context);
  }

  attachSession(session: DocumentSession, options: EditorSessionOptions = {}): void {
    this.documentVersion += 1;
    const documentVersion = this.documentVersion;
    this.documentId = options.documentId ?? null;
    this.documentMode = "session";
    this.languageId = options.languageId ?? null;
    this.disposeSyntaxSession();
    this.disposeHighlighterSession();
    this.session = session;
    this.sessionOptions = options;
    const text = session.getText();
    const internalDocumentId = this.documentId ?? this.generatedOpenSessionId(documentVersion);
    this.highlighterSession = this.pluginHost.createHighlighterSession({
      documentId: internalDocumentId,
      languageId: this.languageId,
      text,
      snapshot: session.getSnapshot(),
    });
    this.syntaxSession = this.createSyntaxSession(internalDocumentId, text);
    this.syntaxStatus = this.syntaxSession ? "loading" : "plain";
    this.syncViewEditability();
    this.setDocument({ text: session.getText(), tokens: session.getTokens() });
    this.applyDocumentScrollPosition(options.scrollPosition);
    this.syncDomSelection();
    this.notifyViewContributions("document", null);
    this.notifyChange(null);
    this.refreshSyntax(documentVersion, null);
  }

  detachSession(): void {
    this.session = null;
    this.sessionOptions = {};
    this.clearSelectionHighlight();
    this.view.setEditable(false);
  }

  clear(): void {
    this.documentVersion += 1;
    this.documentId = null;
    this.documentMode = normalizeEditorDocumentMode(this.options.documentMode);
    this.languageId = null;
    this.syntaxStatus = "plain";
    this.disposeSyntaxSession();
    this.disposeHighlighterSession();
    this.detachSession();
    this.setContent("");
    this.applyDocumentScrollPosition();
    this.notifyViewContributions("clear", null);
  }

  dispose(): void {
    this.uninstallEditingHandlers();
    this.viewContributions.dispose();
    this.disposeEditorFeatureContributions();
    this.keymap.dispose();
    this.highlighterThemeRequests.dispose();
    this.disposeSyntaxSession();
    this.disposeHighlighterSession();
    this.detachSession();
    this.pluginHost.dispose();
    this.view.dispose();
  }

  private resetOwnedDocument(
    document: EditorOpenDocumentOptions,
    options: ResetOwnedDocumentOptions,
  ): number {
    this.documentVersion += 1;
    const documentVersion = this.documentVersion;
    this.documentId =
      options.documentId ??
      (options.persistentIdentity ? this.generatedDocumentId(documentVersion) : null);
    this.documentMode = normalizeEditorDocumentMode(
      document.documentMode ?? this.options.documentMode,
    );
    this.languageId = document.languageId ?? null;
    this.disposeSyntaxSession();
    this.disposeHighlighterSession();

    const internalDocumentId = this.documentId ?? this.generatedOpenSessionId(documentVersion);
    this.session = createEditorDocumentSession(document.text, this.documentMode);
    this.sessionOptions = {};
    this.highlighterSession = this.pluginHost.createHighlighterSession({
      documentId: internalDocumentId,
      languageId: this.languageId,
      text: document.text,
      snapshot: this.session.getSnapshot(),
    });
    this.syntaxSession = this.createSyntaxSession(internalDocumentId, document.text);
    this.syntaxStatus = this.syntaxSession ? "loading" : "plain";
    this.syncViewEditability();
    this.setDocument({ text: this.session.getText(), tokens: [] });
    this.applyRangeDecorations();
    this.applyDocumentScrollPosition(options.scrollPosition);
    this.syncDomSelection();
    this.notifyViewContributions("document", null);
    return documentVersion;
  }

  private createSyntaxSession(documentId: string, text: string): EditorSyntaxSession | null {
    if (!this.languageId || !this.session) return null;

    const options = {
      documentId,
      languageId: this.languageId,
      includeHighlights: !this.highlighterSession,
      text,
      snapshot: this.session.getSnapshot(),
    };
    return (
      this.pluginHost.createSyntaxSession(options) ??
      getEditorSyntaxSessionFactory()?.(options) ??
      null
    );
  }

  private initializeDefaultText(): void {
    if (this.options.defaultText === undefined) return;

    this.resetOwnedDocument(
      {
        text: this.options.defaultText,
        documentMode: normalizeEditorDocumentMode(this.options.documentMode),
        languageId: null,
      },
      {
        documentId: null,
        persistentIdentity: false,
        scrollPosition: DOCUMENT_START_SCROLL_POSITION,
      },
    );
  }

  private applyDocumentScrollPosition(scrollPosition?: EditorScrollPosition): void {
    this.applyScrollPosition({
      top: scrollPosition?.top ?? DOCUMENT_START_SCROLL_POSITION.top,
      left: scrollPosition?.left ?? DOCUMENT_START_SCROLL_POSITION.left,
    });
  }

  private applyScrollPosition(scrollPosition: EditorScrollPosition): void {
    const viewState = this.view.getState();
    const scrollTop = normalizeScrollOffset(
      scrollPosition.top,
      viewState.scrollTop,
      viewState.scrollHeight - viewState.viewportHeight,
    );
    const scrollLeft = normalizeScrollOffset(
      scrollPosition.left,
      viewState.scrollLeft,
      viewState.scrollWidth - viewState.viewportWidth,
    );
    if (scrollTop === viewState.scrollTop && scrollLeft === viewState.scrollLeft) return;

    this.el.scrollTop = scrollTop;
    this.el.scrollLeft = scrollLeft;
    this.view.setScrollMetrics(
      scrollTop,
      viewState.viewportHeight,
      viewState.viewportWidth,
      scrollLeft,
    );
  }

  private generatedDocumentId(documentVersion: number): string {
    return `${this.highlightPrefix}-document-${documentVersion}`;
  }

  private generatedOpenSessionId(documentVersion: number): string {
    return `${this.highlightPrefix}-open-${documentVersion}`;
  }

  private disposeSyntaxSession(): void {
    this.syntaxRequests.cancel();
    this.syntaxSession?.dispose();
    this.syntaxSession = null;
  }

  private disposeHighlighterSession(): void {
    this.highlightRequests.cancel();
    this.highlighterSession?.dispose();
    this.highlighterSession = null;
    this.setHighlighterTheme(null);
  }

  private reloadHighlighterSession(): void {
    this.disposeHighlighterSession();
    if (!this.session) return;

    const documentId = this.currentSessionDocumentId();
    this.highlighterSession = this.pluginHost.createHighlighterSession({
      documentId,
      languageId: this.languageId,
      text: this.session.getText(),
      snapshot: this.session.getSnapshot(),
    });
    this.refreshHighlighterTheme();
    this.refreshHighlightTokens(this.documentVersion, null);
  }

  private handleHighlighterProvidersChanged(): void {
    this.reloadHighlighterSession();
    this.reloadSyntaxSession();
  }

  private reloadSyntaxSession(): void {
    this.disposeSyntaxSession();
    this.clearSyntaxFolds();
    if (!this.session) return;

    this.syntaxSession = this.createSyntaxSession(this.currentSessionDocumentId(), this.getText());
    this.syntaxStatus = this.syntaxSession ? "loading" : "plain";
    this.refreshSyntax(this.documentVersion, null);
    this.notifyChange(null);
  }

  private refreshHighlighterTheme(): void {
    if (!this.pluginHost.hasHighlighterProviders()) {
      this.setProviderHighlighterTheme(null);
      return;
    }

    this.highlighterThemeRequests.schedule({
      run: () => this.pluginHost.loadHighlighterTheme(),
      apply: (theme) => this.setProviderHighlighterTheme(theme),
      fail: () => this.setProviderHighlighterTheme(null),
    });
  }

  private currentSessionDocumentId(): string {
    return this.documentId ?? this.generatedOpenSessionId(this.documentVersion);
  }

  private createInitialViewContributions(
    providers: readonly EditorViewContributionProvider[],
  ): EditorViewContribution[] {
    const contributions: EditorViewContribution[] = [];
    for (const provider of providers) {
      const contribution = this.createViewContribution(provider);
      if (!contribution) continue;

      contributions.push(contribution);
      this.viewContributionsByProvider.set(provider, contribution);
    }

    return contributions;
  }

  private addViewContributionProvider(provider: EditorViewContributionProvider): void {
    const contribution = this.createViewContribution(provider);
    if (!contribution) return;

    this.viewContributionsByProvider.set(provider, contribution);
    this.viewContributions.add(contribution);
  }

  private removeViewContributionProvider(provider: EditorViewContributionProvider): void {
    const contribution = this.viewContributionsByProvider.get(provider);
    if (!contribution) return;

    this.viewContributionsByProvider.delete(provider);
    this.viewContributions.remove(contribution);
  }

  private createViewContribution(
    provider: EditorViewContributionProvider,
  ): EditorViewContribution | null {
    return provider.createContribution(this.createViewContributionContext(this.container));
  }

  private createInitialEditorFeatureContributions(
    providers: readonly EditorFeatureContributionProvider[],
  ): void {
    for (const provider of providers) this.addEditorFeatureContributionProvider(provider, false);
  }

  private addEditorFeatureContributionProvider(
    provider: EditorFeatureContributionProvider,
    notify = true,
  ): void {
    const contribution = provider.createContribution(
      this.createEditorFeatureContributionContext(this.container),
    );
    if (!contribution) return;

    this.editorFeatureContributionsByProvider.set(provider, contribution);
    this.editorFeatureContributions.push(contribution);
    if (notify) contribution.handleEditorChange?.(null);
  }

  private removeEditorFeatureContributionProvider(
    provider: EditorFeatureContributionProvider,
  ): void {
    const contribution = this.editorFeatureContributionsByProvider.get(provider);
    if (!contribution) return;

    this.editorFeatureContributionsByProvider.delete(provider);
    removeArrayItem(this.editorFeatureContributions, contribution);
    contribution.dispose();
  }

  private disposeEditorFeatureContributions(): void {
    while (this.editorFeatureContributions.length > 0) {
      this.editorFeatureContributions.pop()?.dispose();
    }
    this.editorFeatureContributionsByProvider.clear();
  }

  private syncGutterContributions(): void {
    if (!this.view.setGutterContributions(this.currentGutterContributions())) return;

    this.notifyViewContributions("layout", null);
  }

  private currentGutterContributions(): readonly EditorGutterContribution[] {
    return [...this.pluginHost.getGutterContributions()];
  }

  private createViewContributionContext(container: HTMLElement): EditorViewContributionContext {
    return {
      container,
      scrollElement: this.el,
      highlightPrefix: this.highlightPrefix,
      getSnapshot: () => this.createViewSnapshot(),
      revealLine: (row) => this.view.scrollToRow(row),
      focusEditor: () => this.focus(),
      setSelection: (anchor, head, timingName, revealOffset) =>
        this.applyFindSelection(anchor, head, timingName, revealOffset),
      reserveOverlayWidth: (side, width) => this.reserveOverlayWidth(side, width),
      setScrollTop: (scrollTop) => this.setScrollTop(scrollTop),
      textOffsetFromPoint: (clientX, clientY) => this.textOffsetFromPoint(clientX, clientY),
      getRangeClientRect: (start, end) => this.rangeClientRect(start, end),
      setRangeHighlight: (name, ranges, style) => this.view.setRangeHighlight(name, ranges, style),
      clearRangeHighlight: (name) => this.view.clearRangeHighlight(name),
    };
  }

  private createEditorFeatureContributionContext(
    container: HTMLElement,
  ): EditorFeatureContributionContext {
    return {
      container,
      scrollElement: this.el,
      highlightPrefix: this.highlightPrefix,
      hasDocument: () => this.session !== null,
      getText: () => this.getText(),
      getSelections: () => this.resolveViewSelections(),
      focusEditor: () => this.focus(),
      setSelection: (anchor, head, timingName, revealOffset) =>
        this.applyFindSelection(anchor, head, timingName, revealOffset),
      setSelections: (selections, timingName, revealOffset) =>
        this.applyFindSelections(selections, timingName, revealOffset),
      applyEdits: (edits, timingName, selection) =>
        this.applyFindEdits(edits, timingName, selection),
      setRangeHighlight: (name, ranges, style) => this.view.setRangeHighlight(name, ranges, style),
      clearRangeHighlight: (name) => this.view.clearRangeHighlight(name),
      registerCommand: (command, handler) => this.registerCommandHandler(command, handler),
      registerFeature: (id, feature) => this.registerFeature(id, feature),
    };
  }

  private canEditDocument(): boolean {
    return this.editability === "editable" && this.documentMode === "session";
  }

  private syncViewEditability(): void {
    const editable = this.canEditDocument();
    this.view.setEditable(editable);
    this.syncNativeInputHandlers(editable);
  }

  private applyRangeDecorations(): void {
    if (this.text.length === 0 || this.rangeDecorations.length === 0) {
      this.clearAppliedRangeDecorations();
      return;
    }

    const groups = groupedRangeDecorations(this.rangeDecorations, this.highlightPrefix);
    const names: string[] = [];

    for (const group of groups) {
      names.push(group.name);
      this.view.setRangeHighlight(group.name, group.ranges, group.style);
    }

    this.clearStaleAppliedRangeDecorations(new Set(names));
    this.appliedRangeDecorationNames = names;
  }

  private clearAppliedRangeDecorations(): void {
    for (const name of this.appliedRangeDecorationNames) this.view.clearRangeHighlight(name);
    this.appliedRangeDecorationNames = [];
  }

  private clearStaleAppliedRangeDecorations(nextNames: ReadonlySet<string>): void {
    for (const name of this.appliedRangeDecorationNames) {
      if (!nextNames.has(name)) this.view.clearRangeHighlight(name);
    }
  }

  private createViewSnapshot(): EditorViewSnapshot {
    const viewState = this.view.getState();
    const viewport = {
      scrollTop: viewState.scrollTop,
      scrollLeft: viewState.scrollLeft,
      scrollHeight: viewState.scrollHeight,
      scrollWidth: viewState.scrollWidth,
      clientHeight: viewState.viewportHeight,
      clientWidth: viewState.viewportWidth,
      borderBoxHeight: viewState.borderBoxHeight,
      borderBoxWidth: viewState.borderBoxWidth,
      visibleRange: viewState.visibleRange,
    };

    return {
      documentId: this.documentId,
      languageId: this.languageId,
      theme: this.resolvedTheme(),
      text: this.text,
      textVersion: this.documentVersion,
      lineStarts: this.view.getLineStarts(),
      tokens: this.tokens,
      selections: this.resolveViewSelections(),
      metrics: viewState.metrics,
      lineCount: viewState.lineCount,
      contentWidth: viewState.contentWidth,
      totalHeight: viewState.totalHeight,
      tabSize: viewState.tabSize,
      foldMarkers: viewState.foldMarkers,
      visibleRows: viewState.mountedRows.map((row) => ({
        index: row.index,
        bufferRow: row.bufferRow,
        startOffset: row.startOffset,
        endOffset: row.endOffset,
        text: row.text,
        kind: row.kind,
        primaryText: row.displayKind === "text",
        top: row.top,
        height: row.height,
      })),
      viewport,
    };
  }

  private resolveViewSelections(): readonly EditorResolvedSelection[] {
    const snapshot = this.session?.getSnapshot();
    const selections = this.session?.getSelections().selections ?? [];
    if (!snapshot) return [];

    return selections.map((selection) => {
      const resolved = resolveSelection(snapshot, selection);
      return {
        anchorOffset: resolved.anchorOffset,
        headOffset: resolved.headOffset,
        startOffset: resolved.startOffset,
        endOffset: resolved.endOffset,
      };
    });
  }

  private notifyViewContributions(
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null,
  ): void {
    this.viewContributions.notify(kind, change ?? null);
  }

  private notifyEditorFeatureContributions(change: DocumentSessionChange | null): void {
    for (const contribution of this.editorFeatureContributions) {
      contribution.handleEditorChange?.(change);
    }
  }

  private registerCommandHandler(
    command: EditorCommandId,
    handler: EditorCommandHandler,
  ): EditorDisposable {
    this.commandHandlers.set(command, handler);

    return {
      dispose: () => this.unregisterCommandHandler(command, handler),
    };
  }

  private unregisterCommandHandler(command: EditorCommandId, handler: EditorCommandHandler): void {
    if (this.commandHandlers.get(command) !== handler) return;

    this.commandHandlers.delete(command);
  }

  private runRegisteredCommand(
    command: EditorCommandId,
    context: EditorCommandContext,
  ): boolean | null {
    return this.commandHandlers.get(command)?.(context) ?? null;
  }

  private registerFeature<T>(id: string, feature: T): EditorDisposable {
    this.editorFeatures.set(id, feature);

    return {
      dispose: () => this.unregisterFeature(id, feature),
    };
  }

  private unregisterFeature<T>(id: string, feature: T): void {
    if (this.editorFeatures.get(id) !== feature) return;

    this.editorFeatures.delete(id);
  }

  private findFeature(): EditorFindFeature | null {
    return (
      (this.editorFeatures.get(EDITOR_FIND_FEATURE_ID) as EditorFindFeature | undefined) ?? null
    );
  }

  private reserveOverlayWidth(side: EditorOverlaySide, width: number): void {
    if (!this.view.reserveOverlayWidth(side, width)) return;

    this.notifyViewContributions("layout", null);
  }

  private setScrollTop(scrollTop: number): void {
    const maxScrollTop = Math.max(0, this.el.scrollHeight - this.el.clientHeight);
    this.el.scrollTop = clamp(scrollTop, 0, maxScrollTop);
  }

  private readonly handleViewportChange = (): void => {
    this.notifyViewContributions("viewport", null);
  };

  private installEditingHandlers(): void {
    this.el.addEventListener("mousedown", this.handleMouseDown);
    this.el.addEventListener("beforeinput", this.handleBeforeInput);
    this.el.addEventListener("copy", this.handleCopy);
    this.el.addEventListener("drop", this.handleDrop);
    this.el.addEventListener("paste", this.handlePaste);
    this.el.addEventListener("keydown", this.handleKeyDown);
    this.el.addEventListener("keyup", this.syncSessionSelectionFromDom);
    this.el.addEventListener("mouseup", this.syncSessionSelectionFromDom);
    this.el.ownerDocument.addEventListener("selectionchange", this.syncCustomSelectionFromDom);
  }

  private uninstallEditingHandlers(): void {
    this.uninstallNativeInputHandlers();
    this.el.removeEventListener("mousedown", this.handleMouseDown);
    this.el.removeEventListener("beforeinput", this.handleBeforeInput);
    this.el.removeEventListener("copy", this.handleCopy);
    this.el.removeEventListener("drop", this.handleDrop);
    this.el.removeEventListener("paste", this.handlePaste);
    this.el.removeEventListener("keydown", this.handleKeyDown);
    this.el.removeEventListener("keyup", this.syncSessionSelectionFromDom);
    this.el.removeEventListener("mouseup", this.syncSessionSelectionFromDom);
    this.el.ownerDocument.removeEventListener("selectionchange", this.syncCustomSelectionFromDom);
    this.stopMouseSelectionDrag();
  }

  private syncNativeInputHandlers(editable: boolean): void {
    if (editable) {
      this.installNativeInputHandlers();
      return;
    }

    this.uninstallNativeInputHandlers();
  }

  private installNativeInputHandlers(): void {
    if (this.nativeInputHandlersInstalled) return;

    this.view.inputElement.addEventListener(
      "beforeinput",
      this.handleNativeInputBeforeInputCapture,
      {
        capture: true,
      },
    );
    this.view.inputElement.addEventListener("input", this.handleNativeInputInputCapture, {
      capture: true,
    });
    this.nativeInputHandlersInstalled = true;
  }

  private uninstallNativeInputHandlers(): void {
    if (!this.nativeInputHandlersInstalled) return;

    this.view.inputElement.removeEventListener(
      "beforeinput",
      this.handleNativeInputBeforeInputCapture,
      { capture: true },
    );
    this.view.inputElement.removeEventListener("input", this.handleNativeInputInputCapture, {
      capture: true,
    });
    this.nativeInputHandlersInstalled = false;
  }

  private handleNativeInputBeforeInputCapture = (_event: InputEvent): void => {
    this.nativeInputGeneration += 1;
  };

  private handleNativeInputInputCapture = (): void => {
    this.nativeInputGeneration += 1;
  };

  private handleMouseDown = (event: MouseEvent): void => {
    if (!this.session) return;
    if (event.defaultPrevented) return;

    this.view.focusInput();
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

    if (event.altKey) {
      this.addCursorAtOffset(event, offset);
      return;
    }

    this.startMouseSelectionDrag(event, offset);
  };

  private addCursorAtOffset(event: MouseEvent, offset: number): void {
    if (!this.session) return;
    if (event.button !== 0) return;
    if (event.detail !== 1) return;

    const start = eventStartMs(event);
    event.preventDefault();
    const change = this.session.addSelection(offset);
    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.applySessionChange(change, "input.addCursor", start, { syncDomSelection: false });
  }

  private startMouseSelectionDrag(event: MouseEvent, offset: number): void {
    if (event.button !== 0) return;
    if (event.detail !== 1) return;

    event.preventDefault();
    this.view.focusInput();
    this.mouseSelectionDrag = {
      anchorOffset: offset,
      headOffset: offset,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    this.syncCustomSelectionHighlight(offset, offset);
    this.el.ownerDocument.addEventListener("mousemove", this.updateMouseSelectionDrag);
    this.el.ownerDocument.addEventListener("mouseup", this.finishMouseSelectionDrag);
  }

  private updateMouseSelectionDrag = (event: MouseEvent): void => {
    if (!this.mouseSelectionDrag) return;
    if (!this.session) return;

    event.preventDefault();
    this.mouseSelectionDrag.clientX = event.clientX;
    this.mouseSelectionDrag.clientY = event.clientY;
    this.updateMouseSelectionFromDragPoint();
    this.updateMouseSelectionAutoScroll();
  };

  private finishMouseSelectionDrag = (event: MouseEvent): void => {
    const drag = this.mouseSelectionDrag;
    if (!drag || !this.session) {
      this.stopMouseSelectionDrag();
      return;
    }

    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    const offset = this.mouseSelectionOffsetFromPoint(drag.clientX, drag.clientY);
    event.preventDefault();
    this.stopMouseSelectionDrag();

    const start = nowMs();
    const change = this.session.setSelection(drag.anchorOffset, offset);
    const syncDomSelection = drag.anchorOffset === offset;
    this.syncCustomSelectionHighlight(drag.anchorOffset, offset);
    this.useSessionSelectionForNextInput = true;
    this.applySessionChange(change, "input.selection", start, { syncDomSelection });
  };

  private stopMouseSelectionDrag(): void {
    this.mouseSelectionDrag = null;
    this.stopMouseSelectionAutoScroll();
    this.el.ownerDocument.removeEventListener("mousemove", this.updateMouseSelectionDrag);
    this.el.ownerDocument.removeEventListener("mouseup", this.finishMouseSelectionDrag);
  }

  private updateMouseSelectionFromDragPoint(): void {
    const drag = this.mouseSelectionDrag;
    if (!drag || !this.session) return;

    const offset = this.mouseSelectionOffsetFromPoint(drag.clientX, drag.clientY);
    drag.headOffset = offset;
    this.syncCustomSelectionHighlight(drag.anchorOffset, offset);
    this.session.setSelection(drag.anchorOffset, offset);
    this.notifyViewContributions("selection", null);
    this.useSessionSelectionForNextInput = drag.anchorOffset !== offset;
  }

  private mouseSelectionOffsetFromPoint(clientX: number, clientY: number): number {
    return (
      this.view.textOffsetFromPoint(clientX, clientY) ??
      this.view.textOffsetFromViewportPoint(clientX, clientY)
    );
  }

  private updateMouseSelectionAutoScroll(): void {
    const delta = this.mouseSelectionAutoScrollDelta();
    if (delta === 0 || !this.canMouseSelectionAutoScroll(delta)) {
      this.stopMouseSelectionAutoScroll();
      return;
    }

    this.scrollMouseSelection(delta);
    this.scheduleMouseSelectionAutoScroll();
  }

  private mouseSelectionAutoScrollDelta(): number {
    const drag = this.mouseSelectionDrag;
    if (!drag) return 0;

    const rect = this.el.getBoundingClientRect();
    return mouseSelectionAutoScrollDelta(drag.clientY, rect);
  }

  private canMouseSelectionAutoScroll(delta: number): boolean {
    const maxScrollTop = Math.max(0, this.el.scrollHeight - this.el.clientHeight);
    if (delta < 0) return this.el.scrollTop > 0;
    if (delta > 0) return this.el.scrollTop < maxScrollTop;
    return false;
  }

  private scrollMouseSelection(delta: number): void {
    const maxScrollTop = Math.max(0, this.el.scrollHeight - this.el.clientHeight);
    const nextScrollTop = clamp(this.el.scrollTop + delta, 0, maxScrollTop);
    if (nextScrollTop === this.el.scrollTop) return;

    this.el.scrollTop = nextScrollTop;
    this.view.setScrollMetrics(this.el.scrollTop, this.el.clientHeight);
    this.updateMouseSelectionFromDragPoint();
  }

  private scheduleMouseSelectionAutoScroll(): void {
    if (this.mouseSelectionAutoScrollFrame !== 0) return;

    this.mouseSelectionAutoScrollFrame = requestFrame(() => {
      this.mouseSelectionAutoScrollFrame = 0;
      if (!this.mouseSelectionDrag) return;
      this.updateMouseSelectionAutoScroll();
    });
  }

  private stopMouseSelectionAutoScroll(): void {
    if (this.mouseSelectionAutoScrollFrame === 0) return;

    cancelFrame(this.mouseSelectionAutoScrollFrame);
    this.mouseSelectionAutoScrollFrame = 0;
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
    if (!this.canEditDocument()) {
      event.preventDefault();
      return;
    }

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
    if (!this.canEditDocument()) {
      event.preventDefault();
      return;
    }

    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text.length === 0) return;

    const start = eventStartMs(event);
    const selectionChange = this.selectionChangeBeforeEdit();
    event.preventDefault();
    const change = mergeChangeTimings(this.session.applyText(text), selectionChange);
    this.applySessionChange(change, "input.paste", start, {
      revealBlock: "end",
      revealOffset: this.primarySelectionHeadOffset(change),
    });
  };

  private handleDrop = (event: DragEvent): void => {
    if (this.canEditDocument()) return;

    event.preventDefault();
  };

  private handleCopy = (event: ClipboardEvent): void => {
    const text = this.selectedTextForClipboard();
    if (text === null) return;
    if (!event.clipboardData) return;

    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.session) return;
    if (!this.canEditDocument()) return;

    const fallbackText = keyboardFallbackText(event);
    if (fallbackText === null) return;

    this.preventBrowserTextKeyDefault(event, fallbackText);
    this.scheduleKeyboardTextFallback(event, fallbackText);
  };

  private preventBrowserTextKeyDefault(event: KeyboardEvent, text: string): void {
    if (event.target === this.view.inputElement && text !== " ") return;

    event.preventDefault();
  }

  private scheduleKeyboardTextFallback(event: KeyboardEvent, text: string): void {
    const start = eventStartMs(event);
    const nativeInputGeneration = this.nativeInputGeneration;

    this.el.ownerDocument.defaultView?.setTimeout(() => {
      if (!this.session) return;
      if (!this.canEditDocument()) return;
      if (this.nativeInputGeneration !== nativeInputGeneration) return;

      const selectionChange = this.selectionChangeBeforeEdit();
      this.view.inputElement.value = "";
      this.applySessionChange(
        mergeChangeTimings(this.session.applyText(text), selectionChange),
        "input.keydownFallback",
        start,
      );
    }, 0);
  }

  private applyHistoryCommand(command: "undo" | "redo", context: EditorCommandContext): boolean {
    if (!this.session) return false;
    if (!this.canEditDocument()) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const change = command === "undo" ? this.session.undo() : this.session.redo();
    this.applySessionChange(change, command === "undo" ? "input.undo" : "input.redo", start);
    return true;
  }

  private applyDeleteCommand(
    direction: "backward" | "forward",
    context: EditorCommandContext,
  ): boolean {
    if (!this.session) return false;
    if (!this.canEditDocument()) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const selectionChange = this.selectionChangeBeforeEdit();
    const change =
      direction === "backward" ? this.session.backspace() : this.session.deleteSelection();
    this.applySessionChange(
      mergeChangeTimings(change, selectionChange),
      direction === "backward" ? "input.backspace" : "input.delete",
      start,
    );
    return true;
  }

  private applyIndentCommand(
    direction: "indent" | "outdent",
    context: EditorCommandContext,
  ): boolean {
    if (!this.session) return false;
    if (!this.canEditDocument()) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const selectionChange = this.selectionChangeBeforeEdit();
    const change =
      direction === "indent"
        ? this.applyIndentToSession()
        : this.session.outdentSelection(this.tabSize);
    const merged = mergeChangeTimings(change, selectionChange);
    this.applySessionChange(merged, indentTimingName(direction), start, {
      revealOffset: this.primarySelectionHeadOffset(merged),
    });
    return true;
  }

  private applyEditActionCommand(
    command: Parameters<typeof editActionForCommand>[0],
    context: EditorCommandContext,
  ): boolean {
    if (!this.session) return false;
    if (!this.canEditDocument()) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const selectionChange = this.selectionChangeBeforeEdit();
    const snapshot = this.session.getSnapshot();
    const selections = this.session
      .getSelections()
      .selections.map((selection) => resolveSelection(snapshot, selection));
    const action = editActionForCommand(command, this.session.getText(), selections, {
      languageId: this.languageId,
      tabSize: this.tabSize,
    });
    const change = this.session.applyEdits(action.edits, {
      selections: action.selections,
    });
    this.applySessionChange(mergeChangeTimings(change, selectionChange), action.timingName, start, {
      revealOffset: action.revealOffset,
    });
    return true;
  }

  private applyIndentToSession(): DocumentSessionChange {
    if (!this.session) throw new Error("missing editor session");
    if (this.shouldInsertLiteralTab()) return this.session.applyText("\t");
    return this.session.indentSelection("\t");
  }

  private shouldInsertLiteralTab(): boolean {
    if (!this.session) return false;

    const snapshot = this.session.getSnapshot();
    const selections = this.session.getSelections().selections;
    return selections.every((selection) => resolveSelection(snapshot, selection).collapsed);
  }

  private applySelectAllCommand(context: EditorCommandContext): boolean {
    if (!this.session) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const change = this.session.setSelection(0, this.session.getSnapshot().length);
    this.syncCustomSelectionHighlight(0, this.session.getSnapshot().length);
    this.useSessionSelectionForNextInput = true;
    this.applySessionChange(change, "input.selectAll", start, { syncDomSelection: false });
    return true;
  }

  private applyClearSecondarySelections(context: EditorCommandContext): boolean {
    if (!this.session) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const change = this.session.clearSecondarySelections();
    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.applySessionChange(change, "input.clearSecondarySelections", start, {
      syncDomSelection: false,
    });
    return true;
  }

  private applyInsertCursorCommand(
    direction: "above" | "below",
    context: EditorCommandContext,
  ): boolean {
    if (!this.session) return false;

    const resolved = this.resolvedSelections();
    const rowDelta = direction === "above" ? -1 : 1;
    const inserted = resolved
      .map((selection) => this.cursorSelectionByDisplayRows(selection, rowDelta))
      .filter((selection) => selection.anchor !== selection.sourceHead);
    if (inserted.length === 0) return false;

    const selections = [
      ...resolved.map((selection) => ({
        anchor: selection.anchorOffset,
        head: selection.headOffset,
        goal: selection.goal,
      })),
      ...inserted.map((selection) => ({
        anchor: selection.anchor,
        head: selection.anchor,
        goal: selection.goal,
      })),
    ];
    const start = context.event ? eventStartMs(context.event) : nowMs();
    const change = this.session.setSelections(selections);
    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.applySessionChange(change, `input.insertCursor${capitalize(direction)}`, start, {
      revealOffset: inserted[0]?.anchor,
      syncDomSelection: false,
    });
    return true;
  }

  private cursorSelectionByDisplayRows(
    selection: ResolvedSelection,
    rowDelta: -1 | 1,
  ): {
    readonly anchor: number;
    readonly goal: SelectionGoalValue;
    readonly sourceHead: number;
  } {
    const visualColumn = selectionGoalColumn(selection, this.view);
    return {
      anchor: this.view.offsetByDisplayRows(selection.headOffset, rowDelta, visualColumn),
      goal: SelectionGoal.horizontal(visualColumn),
      sourceHead: selection.headOffset,
    };
  }

  private applySelectExactOccurrencesCommand(
    command: "editor.action.selectHighlights" | "editor.action.changeAll",
    context: EditorCommandContext,
  ): boolean {
    if (!this.session) return false;

    const text = this.session.getText();
    const query = this.occurrenceQueryForCurrentSelection(text);
    if (!query) return false;

    const ranges = findAllExactOccurrences(text, query.query);
    if (ranges.length === 0) return false;

    const selections = ranges.map((range) => ({ anchor: range.start, head: range.end }));
    const start = context.event ? eventStartMs(context.event) : nowMs();
    const change = this.session.setSelections(selections);
    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.applySessionChange(change, occurrenceSelectTimingName(command), start, {
      revealOffset: query.range.end,
      syncDomSelection: false,
    });
    return true;
  }

  private applyMoveSelectionToNextOccurrenceCommand(context: EditorCommandContext): boolean {
    if (!this.session) return false;

    const text = this.session.getText();
    const resolved = this.resolvedSelections();
    const source = resolved.at(-1);
    if (!source) return false;

    const query = occurrenceQueryForSelection(text, source);
    if (!query) return false;

    const keptSelections = resolved.slice(0, -1);
    const selected = keptSelections.map((selection) => ({
      start: selection.startOffset,
      end: selection.endOffset,
    }));
    const next = findNextExactOccurrenceFromRange(text, query.query, selected, query.range);
    if (!next) return false;
    if (next.start === query.range.start && next.end === query.range.end) return false;

    const selections = [
      ...keptSelections.map((selection) => ({
        anchor: selection.anchorOffset,
        head: selection.headOffset,
        goal: selection.goal,
      })),
      { anchor: next.start, head: next.end },
    ];
    const start = context.event ? eventStartMs(context.event) : nowMs();
    const change = this.session.setSelections(selections);
    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.applySessionChange(change, "input.moveSelectionToNextFindMatch", start, {
      revealOffset: next.end,
      syncDomSelection: false,
    });
    return true;
  }

  private applyAddNextOccurrenceCommand(context: EditorCommandContext): boolean {
    if (!this.session) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const result = this.addNextExactOccurrence();
    if (!result) return false;

    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.applySessionChange(result.change, "input.addNextOccurrence", start, {
      revealOffset: result.revealOffset,
      syncDomSelection: false,
    });
    return true;
  }

  private resolvedSelections(): readonly ResolvedSelection[] {
    if (!this.session) return [];

    const snapshot = this.session.getSnapshot();
    return this.session
      .getSelections()
      .selections.map((selection) => resolveSelection(snapshot, selection));
  }

  private addNextExactOccurrence(): OccurrenceSelectionChange | null {
    if (!this.session) return null;

    const text = this.session.getText();
    const resolved = this.resolvedSelections();
    const primary = resolved[0];
    if (!primary) return null;

    if (resolved.length === 1 && primary.collapsed) {
      return this.selectCurrentWordForOccurrence(text, primary);
    }

    const query = getOccurrenceQuery(text, resolved);
    if (!query) return null;

    const range = findNextExactOccurrence(text, query, resolved);
    if (!range) return null;

    const selections = [
      ...resolved.map((selection) => ({
        anchor: selection.anchorOffset,
        head: selection.headOffset,
      })),
      { anchor: range.start, head: range.end },
    ];
    return {
      change: this.session.setSelections(selections),
      revealOffset: range.end,
    };
  }

  private occurrenceQueryForCurrentSelection(text: string): OccurrenceQuery | null {
    const resolved = this.resolvedSelections();
    const selected = resolved.find((selection) => !selection.collapsed);
    if (selected) return occurrenceQueryForSelection(text, selected);

    const primary = resolved[0];
    if (!primary) return null;
    return occurrenceQueryForSelection(text, primary);
  }

  private selectCurrentWordForOccurrence(
    text: string,
    selection: ResolvedSelection,
  ): OccurrenceSelectionChange | null {
    if (!this.session) return null;

    const range = wordRangeAtOffset(text, selection.headOffset);
    if (range.start === range.end) return null;

    return {
      change: this.session.setSelection(range.start, range.end),
      revealOffset: range.end,
    };
  }

  private applyNavigationCommand(command: EditorCommandId, context: EditorCommandContext): boolean {
    if (!this.session) return false;

    const snapshot = this.session.getSnapshot();
    const text = this.session.getText();
    const resolvedSelections = this.session
      .getSelections()
      .selections.map((selection) => resolveSelection(snapshot, selection));
    if (resolvedSelections.length === 0) return false;

    const navigation = resolvedSelections.map((resolved) => ({
      resolved,
      target: navigationTargetForCommand({
        command,
        resolved,
        text,
        documentLength: snapshot.length,
        view: this.view,
      }),
    }));
    const primary = navigation[0];
    if (!primary?.target) return false;

    const start = context.event ? eventStartMs(context.event) : nowMs();
    const selections = [];
    for (const { resolved, target } of navigation) {
      if (!target) return false;
      selections.push({
        anchor: target.extend ? resolved.anchorOffset : target.offset,
        head: target.offset,
        goal: target.goal ?? SelectionGoal.none(),
      });
    }
    const change = this.session.setSelections(selections);
    this.useSessionSelectionForNextInput = true;
    this.view.revealOffset(primary.target.offset);
    this.applySessionChange(change, primary.target.timingName, start);
    return true;
  }

  private selectedTextForClipboard(): string | null {
    if (!this.session) return null;

    const snapshot = this.session.getSnapshot();
    const texts = this.session
      .getSelections()
      .selections.map((selection) => resolveSelection(snapshot, selection))
      .filter((selection) => !selection.collapsed)
      .map((selection) => getPieceTableText(snapshot, selection.startOffset, selection.endOffset));
    if (texts.length === 0) return null;

    return texts.join("\n");
  }

  private primarySelectionHeadOffset(change: DocumentSessionChange): number | undefined {
    const selection = change.selections.selections[0];
    if (!selection) return undefined;

    return resolveSelection(change.snapshot, selection).headOffset;
  }

  private applyFindSelection(
    anchorOffset: number,
    headOffset: number,
    timingName: string,
    revealOffset?: number,
  ): void {
    if (!this.session) return;

    const start = nowMs();
    const change = this.session.setSelection(anchorOffset, headOffset);
    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.applySessionChange(change, timingName, start, {
      revealOffset,
      syncDomSelection: false,
    });
  }

  private applyFindSelections(
    selections: readonly EditorSelectionRange[],
    timingName: string,
    revealOffset?: number,
  ): void {
    if (!this.session) return;
    if (selections.length === 0) return;

    const start = nowMs();
    const change = this.session.setSelections(selections);
    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.applySessionChange(change, timingName, start, {
      revealOffset,
      syncDomSelection: false,
    });
  }

  private applyFindEdits(
    edits: readonly TextEdit[],
    timingName: string,
    selection?: EditorSelectionRange,
  ): void {
    if (!this.session) return;
    if (!this.canEditDocument()) return;
    if (edits.length === 0) return;

    const start = nowMs();
    const change = this.session.applyEdits(edits, { selection });
    this.syncSessionSelectionHighlight();
    this.useSessionSelectionForNextInput = true;
    this.applySessionChange(change, timingName, start, {
      revealOffset: this.primarySelectionHeadOffset(change),
      syncDomSelection: false,
    });
  }

  private syncSessionSelectionFromDom = (_event: Event): void => {
    if (!this.session) return;
    if (this.mouseSelectionDrag) return;
    if (this.useSessionSelectionForNextInput) return;
    if (this.isInputFocused()) return;

    const start = nowMs();
    const change = this.updateSessionSelectionFromDom();
    if (!change) return;

    this.useSessionSelectionForNextInput = false;
    const timedChange = appendTiming(change, "input.selection", start);
    this.sessionOptions.onChange?.(timedChange);
    this.notifyViewContributions("selection", null);
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
    if (this.isInputFocused()) {
      this.useSessionSelectionForNextInput = false;
      return null;
    }
    if (!this.useSessionSelectionForNextInput) return this.updateSessionSelectionFromDom();

    this.useSessionSelectionForNextInput = false;
    return null;
  }

  private applySessionChange(
    change: DocumentSessionChange,
    totalName = "editor.change",
    totalStart = nowMs(),
    options: SessionChangeOptions = {},
  ): void {
    let timedChange = change;
    const renderStart = nowMs();
    this.renderSessionChange(change);
    timedChange = appendTiming(timedChange, "editor.render", renderStart);

    if (options.revealOffset !== undefined) {
      const revealStart = nowMs();
      this.view.revealOffset(options.revealOffset, options.revealBlock);
      timedChange = appendTiming(timedChange, "editor.reveal", revealStart);
    }

    if (options.syncDomSelection !== false) {
      const selectionStart = nowMs();
      this.syncDomSelection();
      timedChange = appendTiming(timedChange, "editor.syncDomSelection", selectionStart);
    }
    const finalChange = appendTiming(timedChange, totalName, totalStart);
    this.sessionOptions.onChange?.(finalChange);
    this.refreshSyntax(this.documentVersion, finalChange);
    this.notifyEditorFeatureContributions(finalChange);
    this.notifyViewContributions(viewContributionKindForChange(finalChange), finalChange);
    this.notifyChangeWithTiming(finalChange);
  }

  private renderSessionChange(change: DocumentSessionChange): void {
    const edit = change.edits[0];
    if (change.kind === "selection" || change.kind === "none") return;

    if (edit && change.edits.length === 1) {
      const foldProjection = projectSyntaxFoldsThroughLineEdit(
        this.foldState.folds,
        edit,
        this.text,
      );
      this.applyEdit(edit, projectTokensThroughEdit(this.tokens, edit, this.text));
      this.foldState.applyProjection(foldProjection);
      return;
    }

    this.clearSyntaxFolds();
    this.setDocument({ text: change.text, tokens: [] });
  }

  private notifyChange(change: DocumentSessionChange | null): void {
    this.notifyEditorFeatureContributions(change);
    this.options.onChange?.(this.getState(), change);
  }

  private notifyChangeWithTiming(change: DocumentSessionChange): void {
    const notifyStart = nowMs();
    const state = this.getState();
    const timedChange = appendTiming(change, "editor.notify", notifyStart);
    this.options.onChange?.(state, timedChange);
  }

  private refreshSyntax(documentVersion: number, change: DocumentSessionChange | null): void {
    if (!this.session) return;
    if (change && (change.kind === "none" || change.kind === "selection")) return;

    this.refreshStructuralSyntax(documentVersion, change);
    this.refreshHighlightTokens(documentVersion, change);
  }

  private refreshStructuralSyntax(
    documentVersion: number,
    change: DocumentSessionChange | null,
  ): void {
    if (!this.syntaxSession || !this.session || !this.languageId) return;

    const text = this.session.getText();
    this.syntaxStatus = "loading";

    this.syntaxRequests.schedule({
      delayMs: syntaxRefreshDelay(change),
      run: () => this.loadSyntaxResult(change, text),
      apply: (result, startedAt) => this.applySyntaxResult(result, documentVersion, startedAt),
      fail: () => this.applySyntaxError(documentVersion),
    });
  }

  private refreshHighlightTokens(
    documentVersion: number,
    change: DocumentSessionChange | null,
  ): void {
    if (!this.highlighterSession || !this.session) return;

    const text = this.session.getText();
    this.highlightRequests.schedule({
      delayMs: syntaxRefreshDelay(change),
      run: () => this.loadHighlightResult(change, text),
      apply: (result, startedAt) => this.applyHighlightResult(result, documentVersion, startedAt),
      fail: (_error, startedAt) => this.applyHighlightError(documentVersion, startedAt),
    });
  }

  private loadSyntaxResult(
    change: DocumentSessionChange | null,
    text: string,
  ): Promise<EditorSyntaxResult> {
    if (!this.syntaxSession) return Promise.reject(new Error("No syntax session"));
    if (!change) {
      const snapshot = this.session?.getSnapshot();
      if (!snapshot) return Promise.reject(new Error("No document snapshot"));
      return this.syntaxSession.refresh(snapshot, text);
    }
    return this.syntaxSession.applyChange(change);
  }

  private loadHighlightResult(
    change: DocumentSessionChange | null,
    text: string,
  ): Promise<EditorHighlightResult> {
    if (!this.highlighterSession) return Promise.reject(new Error("No highlighter session"));
    if (!change) {
      const snapshot = this.session?.getSnapshot();
      if (!snapshot) return Promise.reject(new Error("No document snapshot"));
      return this.highlighterSession.refresh(snapshot, text);
    }

    return this.highlighterSession.applyChange(change);
  }

  private applySyntaxResult(
    result: EditorSyntaxResult,
    documentVersion: number,
    startedAt: number,
  ): void {
    if (!this.session || documentVersion !== this.documentVersion) return;

    this.syntaxStatus = "ready";
    const nextTokens = this.highlighterSession ? this.tokens : result.tokens;
    const tokenChange = this.session.adoptTokens(nextTokens);
    const timedChange = appendTiming(tokenChange, "editor.syntax", startedAt);
    if (!this.highlighterSession) this.adoptTokens(result.tokens);
    this.setSyntaxFolds(result.folds);
    this.notifyChange(timedChange);
  }

  private applyHighlightResult(
    result: EditorHighlightResult,
    documentVersion: number,
    startedAt: number,
  ): void {
    if (!this.session || documentVersion !== this.documentVersion) return;

    if (result.theme !== undefined) this.setHighlighterTheme(result.theme);
    const tokenChange = this.session.adoptTokens(result.tokens);
    const timedChange = appendTiming(tokenChange, "editor.highlight", startedAt);
    this.adoptTokens(result.tokens);
    this.notifyChange(timedChange);
  }

  private handleFoldToggle = (marker: VirtualizedFoldMarker): void => {
    if (!this.foldState.toggle(marker)) return;

    this.notifyViewContributions("layout", null);
  };

  private applyFoldOperation(operation: FoldOperation, offset?: number): boolean {
    const location = this.foldLocation(offset);
    if (!location) return false;

    const fold = foldCandidateAtLocation(
      this.foldState.folds,
      location.row,
      location.offset,
      (candidate) => this.foldState.isCollapsed(candidate),
      operation,
    );
    if (!fold) return false;

    const changed = this.applyFoldStateChange(operation, fold);
    if (changed) this.notifyViewContributions("layout", null);
    return changed;
  }

  private foldLocation(offset?: number): { readonly offset: number; readonly row: number } | null {
    const snapshot = this.session?.getSnapshot();
    if (!snapshot) return null;

    const locationOffset = clamp(
      offset ?? this.primarySelectionHeadOffsetFromSession(),
      0,
      snapshot.length,
    );
    return {
      offset: locationOffset,
      row: offsetToPoint(snapshot, locationOffset).row,
    };
  }

  private primarySelectionHeadOffsetFromSession(): number {
    const snapshot = this.session?.getSnapshot();
    const selection = this.session?.getSelections().selections[0];
    if (!snapshot || !selection) return this.getText().length;

    return resolveSelection(snapshot, selection).headOffset;
  }

  private applyFoldStateChange(operation: FoldOperation, fold: FoldRange): boolean {
    if (operation === "fold") return this.foldState.fold(fold);
    if (operation === "unfold") return this.foldState.unfold(fold);
    return this.foldState.toggleFold(fold);
  }

  private clearSyntaxFolds(): void {
    this.foldState.clear();
  }

  private adoptTokens(tokens: readonly EditorToken[]): void {
    this.tokens = tokens;
    this.view.adoptTokens(tokens);
    this.notifyViewContributions("tokens", null);
  }

  private applySyntaxError(documentVersion: number): void {
    if (documentVersion !== this.documentVersion) return;

    this.syntaxStatus = "error";
    this.notifyChange(null);
  }

  private applyHighlightError(documentVersion: number, startedAt: number): void {
    if (!this.session || documentVersion !== this.documentVersion) return;

    this.setHighlighterTheme(null);
    const tokenChange = this.session.adoptTokens([]);
    const timedChange = appendTiming(tokenChange, "editor.highlightError", startedAt);
    this.adoptTokens([]);
    this.notifyChange(timedChange);
  }

  private setHighlighterTheme(theme: EditorTheme | null | undefined): void {
    const nextTheme = theme ?? null;
    if (editorThemesEqual(this.highlighterTheme, nextTheme)) return;

    this.highlighterTheme = nextTheme;
    this.applyResolvedTheme();
  }

  private setProviderHighlighterTheme(theme: EditorTheme | null | undefined): void {
    const nextTheme = theme ?? null;
    if (editorThemesEqual(this.providerHighlighterTheme, nextTheme)) return;

    this.providerHighlighterTheme = nextTheme;
    this.applyResolvedTheme();
  }

  private applyResolvedTheme(): void {
    this.view.setTheme(this.resolvedTheme());
  }

  private resolvedTheme(): EditorTheme | null {
    return mergeEditorThemes(
      this.configuredTheme,
      this.providerHighlighterTheme,
      this.highlighterTheme,
    );
  }

  private syncDomSelection(): void {
    if (!this.session) return;

    // TODO: Move readonly embedded editors to fully custom browser-free selection/copy.
    const selection = this.session.getSelections().selections[0];
    if (!selection) return;

    const resolved = resolveSelection(this.session.getSnapshot(), selection);
    const start = clamp(resolved.startOffset, 0, this.text.length);
    const end = clamp(resolved.endOffset, start, this.text.length);

    if (this.hasFocusedExternalElement()) {
      this.syncSessionSelectionHighlight();
      this.notifyViewContributions("selection", null);
      return;
    }

    if (this.isInputFocused()) {
      this.syncSessionSelectionHighlight();
      this.notifyViewContributions("selection", null);
      return;
    }

    const range = this.view.createRange(start, end, { scrollIntoView: false });
    const domSelection = window.getSelection();
    domSelection?.removeAllRanges();
    if (range) domSelection?.addRange(range);
    this.syncSessionSelectionHighlight();
    this.notifyViewContributions("selection", null);
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
    if (this.useSessionSelectionForNextInput) return;
    if (this.isInputFocused()) return;

    const offsets = this.readDomSelectionOffsets();
    if (!offsets) return;

    this.syncCustomSelectionHighlight(offsets.anchorOffset, offsets.headOffset);
  };

  private syncCustomSelectionHighlight(anchorOffset: number, headOffset: number): void {
    this.view.setSelection(anchorOffset, headOffset);
  }

  private syncSessionSelectionHighlight(): void {
    if (!this.session) return;

    const snapshot = this.session.getSnapshot();
    const selections = this.session.getSelections().selections.map((selection) => {
      const resolved = resolveSelection(snapshot, selection);
      return {
        anchorOffset: resolved.anchorOffset,
        headOffset: resolved.headOffset,
      };
    });
    this.view.setSelections(selections);
  }

  private clearSelectionHighlight(): void {
    this.view.clearSelection();
  }

  private isInputFocused(): boolean {
    return this.el.ownerDocument.activeElement === this.view.inputElement;
  }

  private hasFocusedExternalElement(): boolean {
    const activeElement = this.el.ownerDocument.activeElement;
    if (!activeElement) return false;
    if (activeElement === this.el.ownerDocument.body) return false;
    if (activeElement === this.el.ownerDocument.documentElement) return false;

    return !this.el.contains(activeElement);
  }

  private domBoundaryToTextOffset(node: Node, offset: number): number | null {
    const viewOffset = this.view.textOffsetFromDomBoundary(node, offset);
    if (viewOffset !== null) return viewOffset;

    if (node === this.el) return elementBoundaryToTextOffset(offset, this.text.length);
    return this.externalBoundaryToTextOffset(node, offset);
  }

  private textOffsetFromMouseEvent(event: MouseEvent): number | null {
    return this.textOffsetFromPoint(event.clientX, event.clientY);
  }

  private textOffsetFromPoint(clientX: number, clientY: number): number | null {
    return (
      this.view.textOffsetFromPoint(clientX, clientY) ??
      this.view.textOffsetFromViewportPoint(clientX, clientY)
    );
  }

  private rangeClientRect(start: number, end: number): DOMRect | null {
    const range = this.view.createRange(start, Math.max(start, end), { scrollIntoView: false });
    if (!range) return null;

    const firstRect = range.getClientRects()[0];
    if (firstRect) return firstRect;

    const rect = range.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) return rect;
    return null;
  }

  private externalBoundaryToTextOffset(node: Node, offset: number): number | null {
    if (node.contains(this.el)) {
      const child = childContainingNode(node, this.el);
      const childIndex = child ? childNodeIndex(node, child) : -1;
      if (childIndex === -1) return null;
      return elementBoundaryToTextOffset(offset <= childIndex ? 0 : 1, this.text.length);
    }

    const position = node.compareDocumentPosition(this.el);
    if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return 0;
    if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return this.text.length;
    return null;
  }
}

function viewContributionKindForChange(
  change: DocumentSessionChange,
): EditorViewContributionUpdateKind {
  if (change.kind === "selection") return "selection";
  return "content";
}

function indentTimingName(direction: "indent" | "outdent"): string {
  return direction === "indent" ? "input.indent" : "input.outdent";
}

function removeArrayItem<T>(items: T[], item: T): void {
  const index = items.indexOf(item);
  if (index === -1) return;

  items.splice(index, 1);
}

type ExactOccurrenceRange = {
  readonly start: number;
  readonly end: number;
};

type OccurrenceSelectionChange = {
  readonly change: DocumentSessionChange;
  readonly revealOffset: number;
};

type OccurrenceQuery = {
  readonly query: string;
  readonly range: ExactOccurrenceRange;
};

function getOccurrenceQuery(text: string, selections: readonly ResolvedSelection[]): string | null {
  const selection = selections.find((candidate) => !candidate.collapsed);
  if (!selection) return null;

  return text.slice(selection.startOffset, selection.endOffset);
}

function occurrenceQueryForSelection(
  text: string,
  selection: ResolvedSelection,
): OccurrenceQuery | null {
  if (!selection.collapsed) {
    const query = text.slice(selection.startOffset, selection.endOffset);
    if (query.length === 0) return null;
    return { query, range: { start: selection.startOffset, end: selection.endOffset } };
  }

  const range = wordRangeAtOffset(text, selection.headOffset);
  if (range.start === range.end) return null;
  return { query: text.slice(range.start, range.end), range };
}

function findAllExactOccurrences(text: string, query: string): readonly ExactOccurrenceRange[] {
  if (query.length === 0) return [];

  const ranges: ExactOccurrenceRange[] = [];
  let index = text.indexOf(query);
  while (index !== -1) {
    ranges.push({ start: index, end: index + query.length });
    index = text.indexOf(query, index + query.length);
  }
  return ranges;
}

function findNextExactOccurrence(
  text: string,
  query: string,
  selections: readonly ResolvedSelection[],
): ExactOccurrenceRange | null {
  if (query.length === 0) return null;

  const selected = selections.map((selection) => ({
    start: selection.startOffset,
    end: selection.endOffset,
  }));
  const searchStart = selected.reduce((offset, range) => Math.max(offset, range.end), 0);
  return (
    findExactOccurrenceFrom(text, query, selected, searchStart) ??
    findExactOccurrenceFrom(text, query, selected, 0, searchStart)
  );
}

function findNextExactOccurrenceFromRange(
  text: string,
  query: string,
  selected: readonly ExactOccurrenceRange[],
  range: ExactOccurrenceRange,
): ExactOccurrenceRange | null {
  if (query.length === 0) return null;

  return (
    findExactOccurrenceFrom(text, query, selected, range.end) ??
    findExactOccurrenceFrom(text, query, selected, 0, range.end)
  );
}

function findExactOccurrenceFrom(
  text: string,
  query: string,
  selected: readonly ExactOccurrenceRange[],
  start: number,
  end = text.length,
): ExactOccurrenceRange | null {
  let index = text.indexOf(query, start);

  while (index !== -1 && index < end) {
    const range = { start: index, end: index + query.length };
    if (!selected.some((selection) => rangesOverlap(selection, range))) return range;
    index = text.indexOf(query, index + 1);
  }

  return null;
}

function rangesOverlap(left: ExactOccurrenceRange, right: ExactOccurrenceRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function foldCandidateAtLocation(
  folds: readonly FoldRange[],
  row: number,
  offset: number,
  isCollapsed: (fold: FoldRange) => boolean,
  operation: FoldOperation,
): FoldRange | null {
  let candidate: FoldRange | null = null;

  for (const fold of folds) {
    if (!foldContainsLocation(fold, row, offset)) continue;
    if (!foldMatchesOperation(fold, isCollapsed, operation)) continue;
    if (candidate && compareFoldCandidates(candidate, fold, row, isCollapsed, operation) <= 0)
      continue;
    candidate = fold;
  }

  return candidate;
}

function foldContainsLocation(fold: FoldRange, row: number, offset: number): boolean {
  if (fold.startLine === row) return true;
  return offset >= fold.startIndex && offset < fold.endIndex;
}

function foldMatchesOperation(
  fold: FoldRange,
  isCollapsed: (fold: FoldRange) => boolean,
  operation: FoldOperation,
): boolean {
  const collapsed = isCollapsed(fold);
  if (operation === "fold") return !collapsed;
  if (operation === "unfold") return collapsed;
  return true;
}

function compareFoldCandidates(
  left: FoldRange,
  right: FoldRange,
  row: number,
  isCollapsed: (fold: FoldRange) => boolean,
  operation: FoldOperation,
): number {
  const startRowDelta = foldStartRowScore(left, row) - foldStartRowScore(right, row);
  if (startRowDelta !== 0) return startRowDelta;

  const collapsedDelta =
    foldCollapsedScore(left, isCollapsed, operation) -
    foldCollapsedScore(right, isCollapsed, operation);
  if (collapsedDelta !== 0) return collapsedDelta;

  const spanDelta = foldSpanCandidateDelta(left, right, isCollapsed, operation);
  if (spanDelta !== 0) return spanDelta;

  return left.startIndex - right.startIndex;
}

function foldCollapsedScore(
  fold: FoldRange,
  isCollapsed: (fold: FoldRange) => boolean,
  operation: FoldOperation,
): number {
  if (operation !== "toggle") return 0;
  return isCollapsed(fold) ? 0 : 1;
}

function foldSpanCandidateDelta(
  left: FoldRange,
  right: FoldRange,
  isCollapsed: (fold: FoldRange) => boolean,
  operation: FoldOperation,
): number {
  if (shouldPreferOutermostFold(left, right, isCollapsed, operation)) {
    return foldSpan(right) - foldSpan(left);
  }

  return foldSpan(left) - foldSpan(right);
}

function shouldPreferOutermostFold(
  left: FoldRange,
  right: FoldRange,
  isCollapsed: (fold: FoldRange) => boolean,
  operation: FoldOperation,
): boolean {
  if (operation === "unfold") return true;
  if (operation !== "toggle") return false;
  return isCollapsed(left) && isCollapsed(right);
}

function foldStartRowScore(fold: FoldRange, row: number): number {
  return fold.startLine === row ? 0 : 1;
}

function foldSpan(fold: FoldRange): number {
  return fold.endIndex - fold.startIndex;
}

type VisualColumnView = {
  visualColumnForOffset(offset: number): number;
};

function selectionGoalColumn(selection: ResolvedSelection, view: VisualColumnView): number {
  if (selection.goal.kind === "horizontal") return selection.goal.x;
  if (selection.goal.kind === "horizontalRange") return selection.goal.headX;
  return view.visualColumnForOffset(selection.headOffset);
}

function occurrenceSelectTimingName(
  command: "editor.action.selectHighlights" | "editor.action.changeAll",
): string {
  if (command === "editor.action.selectHighlights") return "input.selectHighlights";
  return "input.changeAll";
}

function createEditorDocumentSession(
  text: string,
  documentMode: EditorDocumentMode,
): DocumentSession {
  if (documentMode === "static") return createStaticDocumentSession(text);
  return createDocumentSession(text);
}

function syncTextEdit(current: string, next: string): TextEdit {
  const prefixLength = commonPrefixLength(current, next);
  const suffixLength = commonSuffixLength(current, next, prefixLength);
  const currentEnd = current.length - suffixLength;
  const nextEnd = next.length - suffixLength;

  return {
    from: prefixLength,
    to: currentEnd,
    text: next.slice(prefixLength, nextEnd),
  };
}

function commonPrefixLength(left: string, right: string): number {
  const maxLength = Math.min(left.length, right.length);
  let length = 0;
  while (length < maxLength && left.charCodeAt(length) === right.charCodeAt(length)) {
    length += 1;
  }

  return length;
}

function commonSuffixLength(left: string, right: string, prefixLength: number): number {
  const maxLength = Math.min(left.length, right.length) - prefixLength;
  let length = 0;
  while (length < maxLength) {
    const leftIndex = left.length - length - 1;
    const rightIndex = right.length - length - 1;
    if (left.charCodeAt(leftIndex) !== right.charCodeAt(rightIndex)) break;

    length += 1;
  }

  return length;
}

function normalizeEditorEditability(value: EditorEditability | undefined): EditorEditability {
  if (value === "readonly") return "readonly";
  return DEFAULT_EDITABILITY;
}

function normalizeEditorDocumentMode(value: EditorDocumentMode | undefined): EditorDocumentMode {
  if (value === "static") return "static";
  return DEFAULT_DOCUMENT_MODE;
}

function rangeDecorationStyle(decoration: EditorRangeDecoration): {
  readonly backgroundColor?: string;
  readonly color?: string;
  readonly textDecoration?: string;
} {
  return {
    backgroundColor: decoration.style?.backgroundColor || undefined,
    color: decoration.style?.color || undefined,
    textDecoration: decoration.style?.textDecoration || undefined,
  };
}

function groupedRangeDecorations(
  decorations: readonly EditorRangeDecoration[],
  highlightPrefix: string,
): readonly RangeDecorationGroup[] {
  const groups: PendingRangeDecorationGroup[] = [];

  for (const decoration of decorations) {
    const style = rangeDecorationStyle(decoration);
    const key = rangeDecorationGroupKey(decoration.className, style);
    const previous = groups.at(-1);
    if (!previous || previous.key !== key) {
      groups.push(rangeDecorationGroup(highlightPrefix, decoration, style, key, groups.length));
      continue;
    }

    previous.ranges.push(decoration);
  }

  return groups;
}

function rangeDecorationGroup(
  highlightPrefix: string,
  decoration: EditorRangeDecoration,
  style: ReturnType<typeof rangeDecorationStyle>,
  key: string,
  index: number,
): PendingRangeDecorationGroup {
  return {
    key,
    name: rangeDecorationGroupName(highlightPrefix, decoration.className, index),
    ranges: [decoration],
    style,
  };
}

function rangeDecorationGroupName(
  highlightPrefix: string,
  className: string | undefined,
  index: number,
): string {
  const semanticName = sanitizedHighlightName(className);
  if (semanticName) return `${highlightPrefix}-range-${semanticName}-${index}`;
  return `${highlightPrefix}-range-decoration-${index}`;
}

function rangeDecorationGroupKey(
  className: string | undefined,
  style: ReturnType<typeof rangeDecorationStyle>,
): string {
  return [
    className ?? "",
    style.backgroundColor ?? "",
    style.color ?? "",
    style.textDecoration ?? "",
  ].join("\u0000");
}

function sameEditorRangeDecorations(
  left: readonly EditorRangeDecoration[],
  right: readonly EditorRangeDecoration[],
): boolean {
  if (left.length !== right.length) return false;

  return left.every((decoration, index) => {
    const next = right[index];
    return next ? sameEditorRangeDecoration(decoration, next) : false;
  });
}

function sameEditorRangeDecoration(
  left: EditorRangeDecoration,
  right: EditorRangeDecoration,
): boolean {
  if (left.start !== right.start) return false;
  if (left.end !== right.end) return false;
  if (left.className !== right.className) return false;

  return sameRangeDecorationStyle(left, right);
}

function sameRangeDecorationStyle(
  left: EditorRangeDecoration,
  right: EditorRangeDecoration,
): boolean {
  const leftStyle = rangeDecorationStyle(left);
  const rightStyle = rangeDecorationStyle(right);
  if (leftStyle.backgroundColor !== rightStyle.backgroundColor) return false;
  if (leftStyle.color !== rightStyle.color) return false;

  return leftStyle.textDecoration === rightStyle.textDecoration;
}

function sanitizedHighlightName(value: string | undefined): string | null {
  const firstClassName = value?.split(/\s+/).find(Boolean);
  if (!firstClassName) return null;

  const sanitized = firstClassName.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
  if (sanitized.length === 0) return null;
  if (/^[a-zA-Z_]/.test(sanitized)) return sanitized;
  return `_${sanitized}`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
