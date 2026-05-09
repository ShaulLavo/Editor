import type {
  DocumentSessionChange,
  EditorDisposable,
  EditorFeatureContribution,
  EditorFeatureContributionContext,
  EditorTheme,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
  TextEdit,
  VirtualizedTextHighlightStyle,
} from "@editor/core"
import {
  createWebSocketLspTransport,
  createWorkerLspTransport,
  lspPositionToOffset,
  LspClient,
  LspWorkspace,
  offsetToLspPosition,
  type LspManagedTransport,
  type LspWebSocketTransportOptions,
  type LspWorkerLike,
} from "@editor/lsp"
import type * as lsp from "vscode-languageserver-protocol"
import {
  diagnosticHighlightGroups,
  summarizeDiagnostics,
  type TypeScriptLspDiagnosticSeverity,
} from "./diagnostics"
import {
  documentUriToFileName,
  isTypeScriptFileName,
  pathOrUriToDocumentUri,
} from "./paths"
import {
  createTooltipController,
  HOVER_REQUEST_DEBOUNCE_MS,
  type TooltipController,
} from "./tooltip"
import type {
  TypeScriptLspDefinitionTarget,
  TypeScriptLspDiagnosticSummary,
  TypeScriptLspPlugin,
  TypeScriptLspPluginOptions,
  TypeScriptLspSourceFile,
  TypeScriptLspStatus,
} from "./types"

export type TypeScriptLspResolvedOptions = {
  readonly rootUri: lsp.DocumentUri | null
  readonly compilerOptions: TypeScriptLspPluginOptions["compilerOptions"]
  readonly diagnosticDelayMs: number
  readonly timeoutMs: number
  readonly workerFactory?: () => LspWorkerLike
  readonly webSocketRoute?: string | URL
  readonly webSocketTransportOptions?: LspWebSocketTransportOptions
  readonly onStatusChange?: (status: TypeScriptLspStatus) => void
  readonly onDiagnostics?: (summary: TypeScriptLspDiagnosticSummary) => void
  readonly onOpenDefinition?: (
    target: TypeScriptLspDefinitionTarget
  ) => void | boolean
  readonly onError?: (error: unknown) => void
}

type ActiveDocument = {
  readonly uri: lsp.DocumentUri
  readonly languageId: string
  readonly text: string
  readonly textVersion: number
  readonly lspVersion: number
}

type DocumentDescriptor = {
  readonly uri: lsp.DocumentUri
  readonly languageId: string
  readonly text: string
  readonly textVersion: number
}

type OffsetRange = {
  readonly start: number
  readonly end: number
}

const DEFAULT_DIAGNOSTIC_DELAY_MS = 150
const DEFAULT_TIMEOUT_MS = 15000

const LINK_HIGHLIGHT_STYLE: VirtualizedTextHighlightStyle = {
  backgroundColor: "transparent",
  color: "#60a5fa",
  textDecoration: "underline solid #60a5fa",
}
const DIAGNOSTIC_STYLES: Record<
  TypeScriptLspDiagnosticSeverity,
  VirtualizedTextHighlightStyle
> = {
  error: {
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    textDecoration: "underline wavy rgba(248, 113, 113, 0.95)",
  },
  warning: { backgroundColor: "rgba(245, 158, 11, 0.26)" },
  information: { backgroundColor: "rgba(59, 130, 246, 0.22)" },
  hint: { backgroundColor: "rgba(148, 163, 184, 0.22)" },
}
const DIAGNOSTIC_SEVERITIES: readonly TypeScriptLspDiagnosticSeverity[] = [
  "error",
  "warning",
  "information",
  "hint",
]

export function createTypeScriptLspPlugin(
  options: TypeScriptLspPluginOptions = {}
): TypeScriptLspPlugin {
  const resolved = resolveOptions(options)
  const state = new TypeScriptLspPluginState()

  return {
    name: "editor.typescript-lsp",
    setWorkspaceFiles: (files) => state.setWorkspaceFiles(files),
    clearWorkspaceFiles: () => state.clearWorkspaceFiles(),
    activate(context) {
      return [
        context.registerViewContribution({
          createContribution: (contributionContext) =>
            new TypeScriptLspContribution(contributionContext, state, resolved),
        }),
        context.registerEditorFeatureContribution({
          createContribution: (contributionContext) =>
            new TypeScriptLspCommandContribution(contributionContext, state),
        }),
      ]
    },
  }
}

class TypeScriptLspPluginState {
  private readonly contributions = new Set<TypeScriptLspContribution>()
  private files: readonly TypeScriptLspSourceFile[] = []

  public get workspaceFiles(): readonly TypeScriptLspSourceFile[] {
    return this.files
  }

  public setWorkspaceFiles(files: readonly TypeScriptLspSourceFile[]): void {
    this.files = files.map((file) => ({ path: file.path, text: file.text }))
    this.notifyWorkspaceFilesChanged()
  }

  public clearWorkspaceFiles(): void {
    this.files = []
    this.notifyWorkspaceFilesChanged()
  }

  public register(contribution: TypeScriptLspContribution): void {
    this.contributions.add(contribution)
  }

  public unregister(contribution: TypeScriptLspContribution): void {
    this.contributions.delete(contribution)
  }

  private notifyWorkspaceFilesChanged(): void {
    for (const contribution of this.contributions)
      contribution.syncWorkspaceFiles()
  }

  public goToDefinitionFromSelection(): boolean {
    for (const contribution of this.contributions) {
      if (contribution.goToDefinitionFromSelection()) return true
    }

    return false
  }
}

class TypeScriptLspCommandContribution implements EditorFeatureContribution {
  private readonly command: EditorDisposable

  public constructor(
    _context: EditorFeatureContributionContext,
    private readonly state: TypeScriptLspPluginState
  ) {
    this.command = _context.registerCommand("goToDefinition", () =>
      this.state.goToDefinitionFromSelection()
    )
  }

  public dispose(): void {
    this.command.dispose()
  }
}

class TypeScriptLspContribution implements EditorViewContribution {
  private readonly workspace = new LspWorkspace()
  private transport: LspManagedTransport | null = null
  private readonly client: LspClient
  private readonly highlightNames: Record<
    TypeScriptLspDiagnosticSeverity,
    string
  >
  private readonly linkHighlightName: string
  private activeDocument: ActiveDocument | null = null
  private activeDiagnostics: readonly lsp.Diagnostic[] = []
  private disposed = false
  private status: TypeScriptLspStatus = "idle"
  private readonly tooltip: TooltipController
  private hoverTimer: ReturnType<typeof setTimeout> | null = null
  private hoverAbort: AbortController | null = null
  private hoverRequestId = 0
  private definitionRequestId = 0
  private definitionHoverRequestId = 0
  private lastPointerOffset: number | null = null
  private linkRange: OffsetRange | null = null
  private currentTheme: EditorTheme | null = null

  public constructor(
    private readonly context: EditorViewContributionContext,
    private readonly state: TypeScriptLspPluginState,
    private readonly options: TypeScriptLspResolvedOptions
  ) {
    const prefix = context.highlightPrefix ?? "editor-typescript-lsp"
    this.highlightNames = createHighlightNames(prefix)
    this.linkHighlightName = `${prefix}-typescript-lsp-definition-link`
    this.client = this.createClient()
    this.tooltip = createTooltipController({
      document: context.container.ownerDocument,
      themeSource: context.scrollElement,
      reentryElement: context.scrollElement,
    })
    this.installPointerHandlers()
    this.state.register(this)
    this.connect()
    this.update(context.getSnapshot(), "document", null)
  }

  public update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change?: DocumentSessionChange | null
  ): void {
    if (this.disposed) return
    this.currentTheme = snapshot.theme ?? null
    if (
      kind === "content" ||
      kind === "document" ||
      kind === "clear" ||
      kind === "viewport"
    ) {
      this.hideHover()
      this.clearDefinitionLink()
    }
    if (!shouldSyncDocument(kind, snapshot, this.activeDocument)) return

    this.syncDocument(snapshot, change ?? null)
  }

  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    this.state.unregister(this)
    this.uninstallPointerHandlers()
    this.hideHover()
    this.clearDefinitionLink()
    this.tooltip.dispose()
    this.clearDiagnosticHighlights()
    this.closeActiveDocument()
    this.client.disconnect()
    this.transport?.close()
    this.transport = null
    this.setStatus("idle")
  }

  public syncWorkspaceFiles(): void {
    if (this.disposed) return
    if (!this.client.initialized) return

    void this.client
      .notify("editor/typescript/setWorkspaceFiles", {
        files: this.state.workspaceFiles,
      })
      .catch((error: unknown) => this.handleError(error))
  }

  public goToDefinitionFromSelection(): boolean {
    const active = this.activeDocument
    if (!active) return false

    const selection = this.context.getSnapshot().selections[0]
    if (!selection) return false
    return this.goToDefinitionAtOffset(selection.headOffset)
  }

  private createClient(): LspClient {
    return new LspClient({
      rootUri: this.options.rootUri,
      workspaceFolders: null,
      workspace: this.workspace,
      timeoutMs: this.options.timeoutMs,
      initializationOptions: {
        compilerOptions: this.options.compilerOptions,
        diagnosticDelayMs: this.options.diagnosticDelayMs,
      },
      notificationHandlers: {
        "textDocument/publishDiagnostics": (_client, params) => {
          this.handlePublishDiagnostics(params)
          return true
        },
      },
    })
  }

  private connect(): void {
    this.setStatus("loading")
    if (this.options.webSocketRoute) {
      void this.connectWebSocket()
      return
    }

    this.connectWorker()
  }

  private connectWorker(): void {
    if (!this.options.workerFactory) {
      this.handleConnectError(
        new Error("TypeScript LSP worker factory was not configured")
      )
      return
    }

    const transport = createWorkerLspTransport(this.options.workerFactory(), {
      messageFormat: "json",
      terminateOnClose: true,
    })
    this.transport = transport
    void this.client
      .connect(transport)
      .then(() => this.handleConnected())
      .catch((error: unknown) => this.handleConnectError(error))
  }

  private async connectWebSocket(): Promise<void> {
    if (!this.options.webSocketRoute) return

    try {
      const transport = await createWebSocketLspTransport(
        this.options.webSocketRoute,
        {
          protocols: this.options.webSocketTransportOptions?.protocols,
          WebSocketCtor: this.options.webSocketTransportOptions?.WebSocketCtor,
        }
      )
      if (this.disposed) {
        transport.close()
        return
      }

      this.transport = transport
      await this.client.connect(transport)
      this.handleConnected()
    } catch (error) {
      this.handleConnectError(error)
    }
  }

  private handleConnected(): void {
    if (this.disposed) return
    this.setStatus("ready")
    this.syncWorkspaceFiles()
  }

  private handleConnectError(error: unknown): void {
    if (this.disposed) return
    this.closeFailedConnection()
    this.setStatus("error")
    this.handleError(error)
  }

  private closeFailedConnection(): void {
    this.client.disconnect()
    this.transport?.close()
    this.transport = null
    this.clearPointerUi()
  }

  private syncDocument(
    snapshot: EditorViewSnapshot,
    change: DocumentSessionChange | null
  ): void {
    const descriptor = documentDescriptor(snapshot)
    if (!descriptor) {
      this.closeActiveDocument()
      return
    }

    this.openOrUpdateDocument(descriptor, change)
  }

  private openOrUpdateDocument(
    descriptor: DocumentDescriptor,
    change: DocumentSessionChange | null
  ): void {
    const active = this.activeDocument
    if (
      !active ||
      active.uri !== descriptor.uri ||
      active.languageId !== descriptor.languageId
    ) {
      this.openDocument(descriptor)
      return
    }

    if (
      active.textVersion === descriptor.textVersion &&
      active.text === descriptor.text
    )
      return
    this.updateDocument(descriptor, change)
  }

  private openDocument(descriptor: DocumentDescriptor): void {
    this.closeActiveDocument()
    const document = this.workspace.openDocument(descriptor)
    this.activeDocument = { ...descriptor, lspVersion: document.version }
  }

  private updateDocument(
    descriptor: DocumentDescriptor,
    change: DocumentSessionChange | null
  ): void {
    const active = this.activeDocument
    const diagnostics = projectDiagnosticsThroughChange(
      active?.text ?? "",
      descriptor.text,
      this.activeDiagnostics,
      change
    )
    const document = this.workspace.updateDocument(
      descriptor.uri,
      descriptor.text,
      {
        edits: editsForChange(change),
      }
    )
    this.activeDocument = { ...descriptor, lspVersion: document.version }
    if (diagnostics === this.activeDiagnostics) return

    this.activeDiagnostics = diagnostics
    this.renderDiagnostics(descriptor.text, diagnostics)
  }

  private closeActiveDocument(): void {
    const active = this.activeDocument
    this.activeDocument = null
    this.activeDiagnostics = []
    if (!active) return

    this.clearDiagnosticHighlights()
    this.workspace.closeDocument(active.uri)
    this.options.onDiagnostics?.(
      summarizeDiagnostics(active.uri, active.lspVersion, [])
    )
  }

  private handlePublishDiagnostics(params: unknown): void {
    const diagnostics = publishDiagnosticsParams(params)
    if (!diagnostics) return

    const active = this.activeDocument
    if (!active) return
    if (diagnostics.uri !== active.uri) return
    if (
      diagnostics.version !== null &&
      diagnostics.version !== active.lspVersion
    )
      return

    this.activeDiagnostics = diagnostics.diagnostics
    this.renderDiagnostics(active.text, diagnostics.diagnostics)
    this.options.onDiagnostics?.(
      summarizeDiagnostics(
        active.uri,
        diagnostics.version,
        diagnostics.diagnostics
      )
    )
  }

  private renderDiagnostics(
    text: string,
    diagnostics: readonly lsp.Diagnostic[]
  ): void {
    if (!this.context.setRangeHighlight) return

    const groups = diagnosticHighlightGroups(text, diagnostics)
    for (const severity of DIAGNOSTIC_SEVERITIES) {
      this.context.setRangeHighlight(
        this.highlightNames[severity],
        groups[severity],
        DIAGNOSTIC_STYLES[severity]
      )
    }
  }

  private clearDiagnosticHighlights(): void {
    if (!this.context.clearRangeHighlight) return

    for (const name of Object.values(this.highlightNames))
      this.context.clearRangeHighlight(name)
  }

  private setStatus(status: TypeScriptLspStatus): void {
    if (this.status === status) return

    this.status = status
    this.options.onStatusChange?.(status)
  }

  private handleError(error: unknown): void {
    this.options.onError?.(error)
  }

  private installPointerHandlers(): void {
    this.context.scrollElement.addEventListener(
      "pointermove",
      this.handlePointerMove
    )
    this.context.scrollElement.addEventListener(
      "pointerleave",
      this.handlePointerLeave
    )
    this.context.scrollElement.addEventListener(
      "mousedown",
      this.handleMouseDown,
      {
        capture: true,
      }
    )
    this.context.container.ownerDocument.addEventListener(
      "pointerdown",
      this.handleDocumentPointerDown,
      {
        capture: true,
      }
    )
    this.context.container.ownerDocument.addEventListener(
      "keydown",
      this.handleKeyDown
    )
    this.context.container.ownerDocument.addEventListener(
      "keyup",
      this.handleKeyUp
    )
  }

  private uninstallPointerHandlers(): void {
    this.context.scrollElement.removeEventListener(
      "pointermove",
      this.handlePointerMove
    )
    this.context.scrollElement.removeEventListener(
      "pointerleave",
      this.handlePointerLeave
    )
    this.context.scrollElement.removeEventListener(
      "mousedown",
      this.handleMouseDown,
      {
        capture: true,
      }
    )
    this.context.container.ownerDocument.removeEventListener(
      "pointerdown",
      this.handleDocumentPointerDown,
      { capture: true }
    )
    this.context.container.ownerDocument.removeEventListener(
      "keydown",
      this.handleKeyDown
    )
    this.context.container.ownerDocument.removeEventListener(
      "keyup",
      this.handleKeyUp
    )
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (event.buttons !== 0) return this.clearPointerUi()
    const inTooltipHoverZone = this.tooltip.pointInHoverZone(
      event.clientX,
      event.clientY
    )
    if (inTooltipHoverZone && !isNavigationModifier(event)) {
      this.lastPointerOffset = null
      this.clearDefinitionLink()
      this.cancelHoverHide()
      return
    }
    if (!this.activeDocument) return this.clearPointerUi()

    const offset = this.context.textOffsetFromPoint(
      event.clientX,
      event.clientY
    )
    if (offset === null) {
      if (inTooltipHoverZone) return this.cancelHoverHide()
      return this.clearPointerUi()
    }

    this.lastPointerOffset = offset
    if (isNavigationModifier(event)) {
      this.requestDefinitionLink(offset)
    } else {
      this.clearDefinitionLink()
    }

    this.scheduleHover(offset)
  }

  private readonly handlePointerLeave = (event: PointerEvent): void => {
    this.lastPointerOffset = null
    this.clearDefinitionLink()
    if (this.tooltip.containsTarget(event.relatedTarget)) {
      this.cancelHoverHide()
      return
    }

    this.scheduleHoverHide()
  }

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return
    if (!isNavigationModifier(event)) return

    const offset = this.context.textOffsetFromPoint(
      event.clientX,
      event.clientY
    )
    if (offset === null) return

    event.preventDefault()
    event.stopImmediatePropagation()
    this.context.focusEditor()
    this.goToDefinitionAtOffset(offset)
  }

  private readonly handleDocumentPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    if (this.tooltip.containsTarget(event.target)) return

    this.clearPointerUi()
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!isNavigationModifier(event)) return
    if (this.lastPointerOffset === null) return

    this.requestDefinitionLink(this.lastPointerOffset)
    this.scheduleHover(this.lastPointerOffset)
  }

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    if (event.key !== "Meta" && event.key !== "Control") return

    this.clearDefinitionLink()
  }

  private scheduleHover(offset: number): void {
    this.cancelHoverHide()
    if (this.hoverTimer) clearTimeout(this.hoverTimer)
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null
      void this.requestHover(offset)
    }, HOVER_REQUEST_DEBOUNCE_MS)
  }

  private async requestHover(offset: number): Promise<void> {
    const active = this.activeDocument
    if (!active) return
    if (!this.client.initialized) return

    this.hoverAbort?.abort()
    const requestId = this.hoverRequestId + 1
    const abort = new AbortController()
    this.hoverRequestId = requestId
    this.hoverAbort = abort

    try {
      const hover = await this.client.request<lsp.Hover | null>(
        "textDocument/hover",
        {
          textDocument: { uri: active.uri },
          position: offsetToLspPosition(active.text, offset),
        } satisfies lsp.TextDocumentPositionParams,
        { signal: abort.signal }
      )
      this.renderHoverResult(requestId, active, offset, hover)
    } catch (error) {
      this.handleRequestError(error)
    }
  }

  private renderHoverResult(
    requestId: number,
    active: ActiveDocument,
    offset: number,
    hover: lsp.Hover | null
  ): void {
    if (requestId !== this.hoverRequestId) return
    if (active !== this.activeDocument) return

    const diagnostics = diagnosticsAtOffset(
      active.text,
      offset,
      this.activeDiagnostics
    )
    if (!hover && diagnostics.length === 0) {
      this.hideHover()
      return
    }

    const range =
      hoverRangeOffsets(active.text, hover) ??
      visibleRangeAtOffset(active.text, offset)
    const rect = this.context.getRangeClientRect(range.start, range.end)
    if (!rect) return this.hideHover()

    this.tooltip.show({
      anchor: rect,
      hoverText: hoverText(hover),
      diagnostics,
      theme: this.currentTheme,
      preferredPlacement: diagnostics.length > 0 ? "bottom" : "top",
    })
  }

  private goToDefinitionAtOffset(offset: number): boolean {
    const active = this.activeDocument
    if (!active) return false
    if (!this.client.initialized) return false

    this.hideHover()
    this.clearDefinitionLink()
    const requestId = this.definitionRequestId + 1
    this.definitionRequestId = requestId
    void this.client
      .request<lsp.Location[] | lsp.Location | lsp.LocationLink[] | null>(
        "textDocument/definition",
        {
          textDocument: { uri: active.uri },
          position: offsetToLspPosition(active.text, offset),
        } satisfies lsp.TextDocumentPositionParams
      )
      .then((result) => this.handleDefinitionResult(requestId, active, result))
      .catch((error: unknown) => this.handleRequestError(error))
    return true
  }

  private requestDefinitionLink(offset: number): void {
    const active = this.activeDocument
    if (!active) return this.clearDefinitionLink()
    if (!this.client.initialized) return this.clearDefinitionLink()

    const range = identifierRangeAtOffset(active.text, offset)
    if (!range) return this.clearDefinitionLink()
    if (sameRange(this.linkRange, range)) return

    const requestId = this.definitionHoverRequestId + 1
    this.definitionHoverRequestId = requestId
    void this.client
      .request<lsp.Location[] | lsp.Location | lsp.LocationLink[] | null>(
        "textDocument/definition",
        {
          textDocument: { uri: active.uri },
          position: offsetToLspPosition(active.text, offset),
        } satisfies lsp.TextDocumentPositionParams
      )
      .then((result) =>
        this.renderDefinitionLink(requestId, active, range, result)
      )
      .catch((error: unknown) => this.handleRequestError(error))
  }

  private renderDefinitionLink(
    requestId: number,
    active: ActiveDocument,
    range: OffsetRange,
    result: lsp.Location[] | lsp.Location | lsp.LocationLink[] | null
  ): void {
    if (requestId !== this.definitionHoverRequestId) return
    if (active !== this.activeDocument) return
    if (!preferredJumpableDefinitionTarget(active, range, result))
      return this.clearDefinitionLink()

    this.linkRange = range
    this.context.setRangeHighlight?.(
      this.linkHighlightName,
      [range],
      LINK_HIGHLIGHT_STYLE
    )
    this.context.scrollElement.style.cursor = "pointer"
  }

  private handleDefinitionResult(
    requestId: number,
    active: ActiveDocument,
    result: lsp.Location[] | lsp.Location | lsp.LocationLink[] | null
  ): void {
    if (requestId !== this.definitionRequestId) return
    if (active !== this.activeDocument) return

    const target = preferredDefinitionTarget(active.uri, result)
    if (!target) return
    if (target.uri === active.uri) {
      this.navigateWithinActiveDocument(active.text, target.range)
      return
    }

    this.options.onOpenDefinition?.(target)
  }

  private navigateWithinActiveDocument(text: string, range: lsp.Range): void {
    const start = lspPositionToOffset(text, range.start)
    const end = lspPositionToOffset(text, range.end)
    this.context.setSelection(start, end, "typescriptLsp.goToDefinition", start)
    this.context.focusEditor()
  }

  private hideHover(): void {
    if (this.hoverTimer) clearTimeout(this.hoverTimer)
    this.hoverTimer = null
    this.hoverAbort?.abort()
    this.hoverAbort = null
    this.hoverRequestId += 1
    this.tooltip.hide()
  }

  private scheduleHoverHide(): void {
    this.tooltip.scheduleHide()
  }

  private cancelHoverHide(): void {
    this.tooltip.cancelHide()
  }

  private clearPointerUi(): void {
    this.hideHover()
    this.clearDefinitionLink()
  }

  private clearDefinitionLink(): void {
    this.definitionHoverRequestId += 1
    this.linkRange = null
    this.context.clearRangeHighlight?.(this.linkHighlightName)
    this.context.scrollElement.style.cursor = ""
  }

  private handleRequestError(error: unknown): void {
    if (isAbortError(error)) return
    this.handleError(error)
  }
}

function resolveOptions(
  options: TypeScriptLspPluginOptions
): TypeScriptLspResolvedOptions {
  return {
    rootUri: options.rootUri ?? "file:///",
    compilerOptions: options.compilerOptions,
    diagnosticDelayMs: options.diagnosticDelayMs ?? DEFAULT_DIAGNOSTIC_DELAY_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    workerFactory: options.workerFactory,
    webSocketRoute: options.webSocketRoute,
    webSocketTransportOptions: options.webSocketTransportOptions,
    onStatusChange: options.onStatusChange,
    onDiagnostics: options.onDiagnostics,
    onOpenDefinition: options.onOpenDefinition,
    onError: options.onError,
  }
}

function shouldSyncDocument(
  kind: EditorViewContributionUpdateKind,
  snapshot: EditorViewSnapshot,
  active: ActiveDocument | null
): boolean {
  if (kind === "document" || kind === "content" || kind === "clear") return true
  if (!active) return false
  return active.textVersion !== snapshot.textVersion
}

function documentDescriptor(
  snapshot: EditorViewSnapshot
): DocumentDescriptor | null {
  if (!snapshot.documentId) return null
  if (!snapshot.languageId) return null
  if (!isTypeScriptLanguage(snapshot.languageId)) return null

  const uri = pathOrUriToDocumentUri(snapshot.documentId)
  if (!isTypeScriptFileName(uri)) return null
  return {
    uri,
    languageId: snapshot.languageId,
    text: snapshot.text,
    textVersion: snapshot.textVersion,
  }
}

function isTypeScriptLanguage(languageId: string): boolean {
  return languageId === "typescript" || languageId === "typescriptreact"
}

function editsForChange(
  change: DocumentSessionChange | null
): readonly TextEdit[] {
  if (!change) return []
  return change.edits
}

function projectDiagnosticsThroughChange(
  previousText: string,
  nextText: string,
  diagnostics: readonly lsp.Diagnostic[],
  change: DocumentSessionChange | null
): readonly lsp.Diagnostic[] {
  if (diagnostics.length === 0) return diagnostics

  const edits = editsForChange(change)
  if (edits.length === 0) return []

  const projected: lsp.Diagnostic[] = []
  for (const diagnostic of diagnostics) {
    const next = projectDiagnosticThroughEdits(
      previousText,
      nextText,
      diagnostic,
      edits
    )
    if (next) projected.push(next)
  }

  return projected
}

function projectDiagnosticThroughEdits(
  previousText: string,
  nextText: string,
  diagnostic: lsp.Diagnostic,
  edits: readonly TextEdit[]
): lsp.Diagnostic | null {
  const start = lspPositionToOffset(previousText, diagnostic.range.start)
  const end = lspPositionToOffset(previousText, diagnostic.range.end)
  const range = projectOffsetRangeThroughEdits({ start, end }, edits)
  if (!range) return null
  if (range.start === range.end && start !== end) return null

  return {
    ...diagnostic,
    range: {
      start: offsetToLspPosition(nextText, range.start),
      end: offsetToLspPosition(nextText, range.end),
    },
  }
}

function projectOffsetRangeThroughEdits(
  range: OffsetRange,
  edits: readonly TextEdit[]
): OffsetRange | null {
  let projected: OffsetRange | null = range
  let delta = 0
  const sorted = edits.toSorted(
    (left, right) => left.from - right.from || left.to - right.to
  )

  for (const edit of sorted) {
    if (!projected) return null

    const adjusted = {
      from: edit.from + delta,
      to: edit.to + delta,
      text: edit.text,
    }
    projected = projectOffsetRangeThroughEdit(projected, adjusted)
    delta += edit.text.length - (edit.to - edit.from)
  }

  return projected
}

function projectOffsetRangeThroughEdit(
  range: OffsetRange,
  edit: TextEdit
): OffsetRange | null {
  const start = projectOffsetThroughEdit(range.start, edit, "after")
  const end = projectOffsetThroughEdit(range.end, edit, "before")
  if (start === null || end === null) return null
  if (end < start) return null

  return { start, end }
}

function projectOffsetThroughEdit(
  offset: number,
  edit: TextEdit,
  insertionBias: "before" | "after"
): number | null {
  if (edit.from === edit.to)
    return projectOffsetThroughInsertion(offset, edit, insertionBias)
  if (offset < edit.from) return offset
  if (offset > edit.to) return offset + edit.text.length - (edit.to - edit.from)
  if (offset === edit.to) return edit.from + edit.text.length
  if (offset === edit.from) return edit.from
  return null
}

function projectOffsetThroughInsertion(
  offset: number,
  edit: TextEdit,
  insertionBias: "before" | "after"
): number {
  if (offset < edit.from) return offset
  if (offset > edit.from) return offset + edit.text.length
  if (insertionBias === "after") return offset + edit.text.length
  return offset
}

function publishDiagnosticsParams(params: unknown): {
  readonly uri: lsp.DocumentUri
  readonly version: number | null
  readonly diagnostics: readonly lsp.Diagnostic[]
} | null {
  if (!isRecord(params)) return null
  if (typeof params.uri !== "string") return null
  if (!Array.isArray(params.diagnostics)) return null

  return {
    uri: params.uri,
    version: typeof params.version === "number" ? params.version : null,
    diagnostics: params.diagnostics as lsp.Diagnostic[],
  }
}

function createHighlightNames(
  prefix: string
): Record<TypeScriptLspDiagnosticSeverity, string> {
  return {
    error: `${prefix}-typescript-lsp-error`,
    warning: `${prefix}-typescript-lsp-warning`,
    information: `${prefix}-typescript-lsp-information`,
    hint: `${prefix}-typescript-lsp-hint`,
  }
}

function hoverText(hover: lsp.Hover | null): string | null {
  if (!hover) return null

  const text = hoverContentsText(hover.contents).trim()
  if (!text) return null
  return text
}

function hoverContentsText(contents: lsp.Hover["contents"]): string {
  if (typeof contents === "string") return contents
  if (Array.isArray(contents))
    return contents.map(markedStringText).join("\n\n")
  if ("kind" in contents) return contents.value
  return markedStringText(contents)
}

function markedStringText(value: lsp.MarkedString): string {
  if (typeof value === "string") return value
  return ["```" + value.language, value.value, "```"].join("\n")
}

function hoverRangeOffsets(
  text: string,
  hover: lsp.Hover | null
): { readonly start: number; readonly end: number } | null {
  if (!hover?.range) return null

  const start = lspPositionToOffset(text, hover.range.start)
  const end = lspPositionToOffset(text, hover.range.end)
  if (end > start) return { start, end }
  return null
}

function visibleRangeAtOffset(text: string, offset: number): OffsetRange {
  const start = Math.max(0, Math.min(offset, Math.max(0, text.length - 1)))
  return { start, end: Math.min(text.length, start + 1) }
}

function identifierRangeAtOffset(
  text: string,
  offset: number
): OffsetRange | null {
  const clamped = Math.max(0, Math.min(offset, text.length))
  const index = identifierIndexAtOffset(text, clamped)
  if (index === null) return null

  let start = index
  while (start > 0 && isIdentifierCharacter(text[start - 1] ?? "")) start -= 1

  let end = index + 1
  while (end < text.length && isIdentifierCharacter(text[end] ?? "")) end += 1

  if (end <= start) return null
  return { start, end }
}

function identifierIndexAtOffset(text: string, offset: number): number | null {
  if (isIdentifierCharacter(text[offset] ?? "")) return offset
  if (offset > 0 && isIdentifierCharacter(text[offset - 1] ?? ""))
    return offset - 1
  return null
}

function isIdentifierCharacter(value: string): boolean {
  return /^[A-Za-z0-9_$]$/.test(value)
}

function sameRange(left: OffsetRange | null, right: OffsetRange): boolean {
  return left?.start === right.start && left.end === right.end
}

function diagnosticsAtOffset(
  text: string,
  offset: number,
  diagnostics: readonly lsp.Diagnostic[]
): readonly lsp.Diagnostic[] {
  return diagnostics.filter((diagnostic) =>
    diagnosticContainsOffset(text, diagnostic, offset)
  )
}

function diagnosticContainsOffset(
  text: string,
  diagnostic: lsp.Diagnostic,
  offset: number
): boolean {
  const start = lspPositionToOffset(text, diagnostic.range.start)
  const end = lspPositionToOffset(text, diagnostic.range.end)
  if (end > start) return offset >= start && offset <= end
  return offset === start
}

function preferredDefinitionTarget(
  activeUri: lsp.DocumentUri,
  result: lsp.Location[] | lsp.Location | lsp.LocationLink[] | null
): TypeScriptLspDefinitionTarget | null {
  return preferredTarget(activeUri, definitionTargets(result))
}

function preferredJumpableDefinitionTarget(
  active: ActiveDocument,
  sourceRange: OffsetRange,
  result: lsp.Location[] | lsp.Location | lsp.LocationLink[] | null
): TypeScriptLspDefinitionTarget | null {
  const targets = definitionTargets(result).filter(
    (target) => !targetIsSourceRange(active, sourceRange, target)
  )
  return preferredTarget(active.uri, targets)
}

function preferredTarget(
  activeUri: lsp.DocumentUri,
  targets: readonly TypeScriptLspDefinitionTarget[]
): TypeScriptLspDefinitionTarget | null {
  return (
    targets.find((target) => target.uri === activeUri) ??
    targets.find((target) => !target.path.includes("/node_modules/")) ??
    targets[0] ??
    null
  )
}

function targetIsSourceRange(
  active: ActiveDocument,
  sourceRange: OffsetRange,
  target: TypeScriptLspDefinitionTarget
): boolean {
  if (target.uri !== active.uri) return false

  const targetStart = lspPositionToOffset(active.text, target.range.start)
  const targetEnd = lspPositionToOffset(active.text, target.range.end)
  return rangesOverlap(sourceRange, { start: targetStart, end: targetEnd })
}

function rangesOverlap(left: OffsetRange, right: OffsetRange): boolean {
  return left.start < right.end && right.start < left.end
}

function definitionTargets(
  result: lsp.Location[] | lsp.Location | lsp.LocationLink[] | null
): readonly TypeScriptLspDefinitionTarget[] {
  if (!result) return []
  const items = Array.isArray(result) ? result : [result]
  return items.flatMap(definitionTarget)
}

function definitionTarget(
  item: lsp.Location | lsp.LocationLink
): readonly TypeScriptLspDefinitionTarget[] {
  const uri = "targetUri" in item ? item.targetUri : item.uri
  const range =
    "targetSelectionRange" in item ? item.targetSelectionRange : item.range
  const fileName = documentUriToFileName(uri)
  if (!fileName) return []

  return [
    {
      uri,
      path: fileName.replace(/^\/+/, ""),
      range,
    },
  ]
}

function isNavigationModifier(event: {
  readonly metaKey: boolean
  readonly ctrlKey: boolean
}): boolean {
  return event.metaKey || event.ctrlKey
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true
  if (!isRecord(error)) return false
  return error.name === "LspRequestCancelledError"
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
