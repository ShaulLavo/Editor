import {
  EDITOR_MINIMAP_FEATURE_ID,
  type DocumentSessionChange,
  type EditorCommandId,
  type EditorDisposable,
  type EditorFeatureContribution,
  type EditorFeatureContributionContext,
  type EditorMinimapDecoration,
  type EditorMinimapFeature,
  type EditorTheme,
  type EditorViewContribution,
  type EditorViewContributionContext,
  type EditorViewContributionUpdateKind,
  type EditorViewSnapshot,
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
  COMPLETION_REQUEST_DEBOUNCE_MS,
  TYPESCRIPT_LSP_COMPLETION_EDIT_FEATURE_ID,
  completionAnchorRange,
  completionApplication,
  completionItems,
  completionTriggerFromChange,
  createCompletionWidgetController,
  type CompletionWidgetController,
  type TypeScriptLspCompletionApplication,
  type TypeScriptLspCompletionEditFeature,
  type TypeScriptLspCompletionTrigger,
} from "./completion"
import {
  identifierRangeAtOffset,
  navigateToTarget,
  preferredDefinitionTarget,
  preferredJumpableDefinitionTarget,
  preferredReferenceTarget,
  requestDefinition,
  requestNavigationTargets,
  sameOffsetRange,
  type DefinitionResult,
  type OffsetRange,
} from "./definitionNavigation"
import {
  diagnosticHighlightGroups,
  summarizeDiagnostics,
  type TypeScriptLspDiagnosticSeverity,
} from "./diagnostics"
import {
  diagnosticsAtOffset,
  editsForChange,
  projectDiagnostics,
} from "./diagnosticProjection"
import { isTypeScriptLspSourceFileName, pathOrUriToDocumentUri } from "./paths"
import { DIAGNOSTIC_STYLES, LINK_HIGHLIGHT_STYLE } from "./plugin.styles"
import {
  createTooltipController,
  HOVER_REQUEST_DEBOUNCE_MS,
  type TooltipController,
} from "./tooltip"
import type {
  TypeScriptLspDefinitionTarget,
  TypeScriptLspDiagnosticSummary,
  TypeScriptLspNavigationKind,
  TypeScriptLspNavigationOpenMode,
  TypeScriptLspNavigationOptions,
  TypeScriptLspReferencesResult,
  TypeScriptLspPlugin,
  TypeScriptLspPluginOptions,
  TypeScriptLspSourceFile,
  TypeScriptLspStatus,
} from "./types"

export type TypeScriptLspResolvedOptions = {
  readonly rootUri: lsp.DocumentUri | null
  readonly compilerOptions: TypeScriptLspPluginOptions["compilerOptions"]
  readonly diagnosticDelayMs: number
  readonly hoverMarkdownCodeBackground: boolean
  readonly timeoutMs: number
  readonly workerFactory?: () => LspWorkerLike
  readonly webSocketRoute?: string | URL
  readonly webSocketTransportOptions?: LspWebSocketTransportOptions
  readonly onStatusChange?: (status: TypeScriptLspStatus) => void
  readonly onDiagnostics?: (summary: TypeScriptLspDiagnosticSummary) => void
  readonly onOpenDefinition?: (
    target: TypeScriptLspDefinitionTarget,
    options?: TypeScriptLspNavigationOptions
  ) => void | boolean
  readonly onOpenReferences?: (
    result: TypeScriptLspReferencesResult
  ) => void | boolean
  readonly onError?: (error: unknown) => void
}

type TypeScriptLspNavigationCommand = {
  readonly kind: TypeScriptLspNavigationKind
  readonly openMode: TypeScriptLspNavigationOpenMode
  readonly includeDeclaration?: boolean
}

type DiagnosticMarkerDirection = "next" | "previous"

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

type CompletionSession = {
  readonly active: ActiveDocument
  readonly offset: number
}

const DEFAULT_DIAGNOSTIC_DELAY_MS = 150
const DEFAULT_TIMEOUT_MS = 15000
const TYPESCRIPT_LSP_MINIMAP_SOURCE_ID = "editor.typescript-lsp.diagnostics"
const LSP_DIAGNOSTIC_ERROR = 1
const LSP_DIAGNOSTIC_WARNING = 2
const LSP_DIAGNOSTIC_INFORMATION = 3
const LSP_DIAGNOSTIC_HINT = 4

const DIAGNOSTIC_SEVERITIES: readonly TypeScriptLspDiagnosticSeverity[] = [
  "error",
  "warning",
  "information",
  "hint",
]

const DIAGNOSTIC_MINIMAP_COLORS: Record<
  TypeScriptLspDiagnosticSeverity,
  string
> = {
  error: "rgba(239, 68, 68, 1)",
  warning: "rgba(245, 158, 11, 0.95)",
  information: "rgba(59, 130, 246, 0.9)",
  hint: "rgba(148, 163, 184, 0.85)",
}

const DIAGNOSTIC_MINIMAP_Z_INDEX: Record<
  TypeScriptLspDiagnosticSeverity,
  number
> = {
  error: 40,
  warning: 30,
  information: 20,
  hint: 10,
}

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
    return this.runNavigationCommand({
      kind: "definition",
      openMode: "default",
    })
  }

  public runNavigationCommand(command: TypeScriptLspNavigationCommand): boolean {
    for (const contribution of this.contributions) {
      if (contribution.runNavigationCommand(command)) return true
    }

    return false
  }

  public moveDiagnosticMarker(direction: DiagnosticMarkerDirection): boolean {
    for (const contribution of this.contributions) {
      if (contribution.moveDiagnosticMarker(direction)) return true
    }

    return false
  }
}

class TypeScriptLspCommandContribution implements EditorFeatureContribution {
  private readonly commands: readonly EditorDisposable[]
  private readonly completionFeature: EditorDisposable

  public constructor(
    context: EditorFeatureContributionContext,
    private readonly state: TypeScriptLspPluginState
  ) {
    this.commands = TYPESCRIPT_LSP_COMMANDS.map((command) =>
      context.registerCommand(command.id, () => command.run(this.state))
    )
    this.completionFeature = context.registerFeature(
      TYPESCRIPT_LSP_COMPLETION_EDIT_FEATURE_ID,
      completionEditFeature(context)
    )
  }

  public dispose(): void {
    for (const command of this.commands) command.dispose()
    this.completionFeature.dispose()
  }
}

function completionEditFeature(
  context: EditorFeatureContributionContext
): TypeScriptLspCompletionEditFeature {
  return {
    applyCompletion(application: TypeScriptLspCompletionApplication): boolean {
      if (!context.hasDocument()) return false

      context.applyEdits(
        application.edits,
        "typescriptLsp.completion.accept",
        application.selection
      )
      context.focusEditor()
      return true
    },
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
  private completionTimer: ReturnType<typeof setTimeout> | null = null
  private completionAbort: AbortController | null = null
  private completionRequestId = 0
  private completionSession: CompletionSession | null = null
  private definitionRequestId = 0
  private definitionHoverRequestId = 0
  private lastPointerOffset: number | null = null
  private linkRange: OffsetRange | null = null
  private currentTheme: EditorTheme | null = null
  private readonly completion: CompletionWidgetController

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
      markdownCodeBackground: this.options.hoverMarkdownCodeBackground,
    })
    this.completion = createCompletionWidgetController({
      document: context.container.ownerDocument,
      themeSource: context.scrollElement,
      onSelect: () => {
        this.acceptCompletion()
      },
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
    if (shouldSyncDocument(kind, snapshot, this.activeDocument)) {
      this.syncDocument(snapshot, change ?? null)
    }

    this.handleCompletionUpdate(snapshot, kind, change ?? null)
  }

  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    this.state.unregister(this)
    this.uninstallPointerHandlers()
    this.hideHover()
    this.hideCompletion()
    this.clearDefinitionLink()
    this.tooltip.dispose()
    this.completion.dispose()
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
    return this.runNavigationCommand({
      kind: "definition",
      openMode: "default",
    })
  }

  public runNavigationCommand(command: TypeScriptLspNavigationCommand): boolean {
    const selection = this.context.getSnapshot().selections[0]
    if (!selection) return false
    return this.requestNavigationAtOffset(selection.headOffset, command)
  }

  public moveDiagnosticMarker(direction: DiagnosticMarkerDirection): boolean {
    const active = this.activeDocument
    if (!active) return false

    const selection = this.context.getSnapshot().selections[0]
    if (!selection) return false

    const range = diagnosticMarkerTarget(
      active.text,
      this.activeDiagnostics,
      selection.headOffset,
      direction
    )
    if (!range) return false

    const timingName = `typescriptLsp.marker.${direction}`
    this.context.setSelection(range.start, range.end, timingName, range.start)
    this.context.focusEditor()
    return true
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
    this.hideCompletion()
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
    const diagnostics = projectDiagnostics(this.activeDiagnostics, {
      previousText: active?.text ?? "",
      nextText: descriptor.text,
      change,
    })
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
    this.hideCompletion()
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
    this.renderDiagnosticHighlights(text, diagnostics)
    this.renderDiagnosticMinimapMarkers(diagnostics)
  }

  private renderDiagnosticHighlights(
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

  private renderDiagnosticMinimapMarkers(
    diagnostics: readonly lsp.Diagnostic[]
  ): void {
    const minimap = this.minimapFeature()
    if (!minimap) return

    minimap.setDecorations(
      TYPESCRIPT_LSP_MINIMAP_SOURCE_ID,
      diagnosticMinimapDecorations(
        this.context.getSnapshot().lineCount,
        diagnostics
      )
    )
  }

  private clearDiagnosticHighlights(): void {
    this.clearDiagnosticMinimapMarkers()
    if (!this.context.clearRangeHighlight) return

    for (const name of Object.values(this.highlightNames))
      this.context.clearRangeHighlight(name)
  }

  private clearDiagnosticMinimapMarkers(): void {
    this.minimapFeature()?.clearDecorations(TYPESCRIPT_LSP_MINIMAP_SOURCE_ID)
  }

  private minimapFeature(): EditorMinimapFeature | null {
    return (
      this.context.getFeature?.<EditorMinimapFeature>(
        EDITOR_MINIMAP_FEATURE_ID
      ) ?? null
    )
  }

  private setStatus(status: TypeScriptLspStatus): void {
    if (this.status === status) return

    this.status = status
    this.options.onStatusChange?.(status)
  }

  private handleError(error: unknown): void {
    this.options.onError?.(error)
  }

  private handleCompletionUpdate(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change: DocumentSessionChange | null
  ): void {
    if (kind === "document" || kind === "clear") {
      this.hideCompletion()
      return
    }
    if (kind === "selection" || kind === "viewport" || kind === "layout") {
      this.hideCompletion()
      return
    }
    if (kind !== "content") return

    const trigger = completionTriggerFromChange(change)
    if (!trigger) {
      this.hideCompletion()
      return
    }

    this.scheduleCompletion(snapshot, trigger)
  }

  private scheduleCompletion(
    snapshot: EditorViewSnapshot,
    trigger: TypeScriptLspCompletionTrigger
  ): void {
    const active = this.activeDocument
    if (!active || !this.client.initialized) return this.hideCompletion()

    const selection = primaryCollapsedSelection(snapshot)
    if (!selection) return this.hideCompletion()

    const offset = selection.headOffset
    this.cancelCompletionRequest()
    this.completionTimer = setTimeout(() => {
      this.completionTimer = null
      void this.requestCompletion(active, offset, trigger)
    }, COMPLETION_REQUEST_DEBOUNCE_MS)
  }

  private requestManualCompletion(): void {
    const active = this.activeDocument
    if (!active || !this.client.initialized) return this.hideCompletion()

    const selection = primaryCollapsedSelection(this.context.getSnapshot())
    if (!selection) return this.hideCompletion()

    this.cancelCompletionRequest()
    void this.requestCompletion(active, selection.headOffset, { triggerKind: 1 })
  }

  private async requestCompletion(
    active: ActiveDocument,
    offset: number,
    trigger: TypeScriptLspCompletionTrigger
  ): Promise<void> {
    this.completionAbort?.abort()
    const requestId = this.completionRequestId + 1
    const abort = new AbortController()
    this.completionRequestId = requestId
    this.completionAbort = abort

    try {
      const result = await this.client.request<
        lsp.CompletionList | readonly lsp.CompletionItem[] | null
      >(
        "textDocument/completion",
        {
          textDocument: { uri: active.uri },
          position: offsetToLspPosition(active.text, offset),
          context: trigger,
        } satisfies lsp.CompletionParams,
        { signal: abort.signal }
      )
      this.renderCompletionResult(requestId, active, offset, completionItems(result))
    } catch (error) {
      this.handleRequestError(error)
    }
  }

  private renderCompletionResult(
    requestId: number,
    active: ActiveDocument,
    offset: number,
    items: readonly lsp.CompletionItem[]
  ): void {
    if (requestId !== this.completionRequestId) return
    if (active !== this.activeDocument) return
    if (items.length === 0) return this.hideCompletion()

    const range = completionAnchorRange(active.text, offset)
    const rect = this.context.getRangeClientRect(range.start, range.end)
    if (!rect) return this.hideCompletion()

    this.hideHover()
    this.clearDefinitionLink()
    this.completionSession = { active, offset }
    this.completion.show({
      anchor: rect,
      items: items.slice(0, 100),
    })
  }

  private acceptCompletion(): boolean {
    const session = this.completionSession
    const item = this.completion.selectedItem()
    if (!session || !item) return false
    if (session.active !== this.activeDocument) return false

    const application = completionApplication(
      session.active.text,
      session.offset,
      item
    )
    if (!application) return false

    const feature = this.completionEditFeature()
    if (!feature) return false

    this.hideCompletion()
    return feature.applyCompletion(application)
  }

  private completionEditFeature(): TypeScriptLspCompletionEditFeature | null {
    return (
      this.context.getFeature?.<TypeScriptLspCompletionEditFeature>(
        TYPESCRIPT_LSP_COMPLETION_EDIT_FEATURE_ID
      ) ?? null
    )
  }

  private cancelCompletionRequest(): void {
    if (this.completionTimer) clearTimeout(this.completionTimer)
    this.completionTimer = null
    this.completionAbort?.abort()
    this.completionAbort = null
    this.completionRequestId += 1
  }

  private hideCompletion(): void {
    this.cancelCompletionRequest()
    this.completionSession = null
    this.completion.hide()
  }

  private installPointerHandlers(): void {
    this.context.scrollElement.addEventListener(
      "keydown",
      this.handleCompletionKeyDown,
      {
        capture: true,
      }
    )
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
      "keydown",
      this.handleCompletionKeyDown,
      {
        capture: true,
      }
    )
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
    if (this.completion.containsTarget(event.target)) return

    this.clearPointerUi()
    this.hideCompletion()
  }

  private readonly handleCompletionKeyDown = (event: KeyboardEvent): void => {
    if (isCompletionManualTrigger(event)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      this.requestManualCompletion()
      return
    }
    if (!this.completion.isVisible()) return

    if (event.key === "ArrowDown") {
      this.consumeCompletionKey(event)
      this.completion.moveSelection(1)
      return
    }
    if (event.key === "ArrowUp") {
      this.consumeCompletionKey(event)
      this.completion.moveSelection(-1)
      return
    }
    if (event.key === "PageDown") {
      this.consumeCompletionKey(event)
      this.completion.moveSelection(8)
      return
    }
    if (event.key === "PageUp") {
      this.consumeCompletionKey(event)
      this.completion.moveSelection(-8)
      return
    }
    if (event.key === "Escape") {
      this.consumeCompletionKey(event)
      this.hideCompletion()
      return
    }
    if (event.key !== "Enter" && event.key !== "Tab") return

    this.consumeCompletionKey(event)
    this.acceptCompletion()
  }

  private consumeCompletionKey(event: KeyboardEvent): void {
    event.preventDefault()
    event.stopImmediatePropagation()
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
    return this.requestNavigationAtOffset(offset, {
      kind: "definition",
      openMode: "default",
    })
  }

  private requestNavigationAtOffset(
    offset: number,
    command: TypeScriptLspNavigationCommand
  ): boolean {
    const active = this.activeDocument
    if (!active) return false
    if (!this.client.initialized) return false

    this.hideHover()
    this.clearDefinitionLink()
    const requestId = this.definitionRequestId + 1
    this.definitionRequestId = requestId
    void requestNavigationTargets(this.client, {
      uri: active.uri,
      text: active.text,
      offset,
      kind: command.kind,
      includeDeclaration: command.includeDeclaration,
    })
      .then((result) =>
        this.handleNavigationResult(requestId, active, offset, command, result)
      )
      .catch((error: unknown) => this.handleRequestError(error))
    return true
  }

  private requestDefinitionLink(offset: number): void {
    const active = this.activeDocument
    if (!active) return this.clearDefinitionLink()
    if (!this.client.initialized) return this.clearDefinitionLink()

    const range = identifierRangeAtOffset(active.text, offset)
    if (!range) return this.clearDefinitionLink()
    if (sameOffsetRange(this.linkRange, range)) return

    const requestId = this.definitionHoverRequestId + 1
    this.definitionHoverRequestId = requestId
    void requestDefinition(this.client, {
      uri: active.uri,
      text: active.text,
      offset,
    })
      .then((result) =>
        this.renderDefinitionLink(requestId, active, range, result)
      )
      .catch((error: unknown) => this.handleRequestError(error))
  }

  private renderDefinitionLink(
    requestId: number,
    active: ActiveDocument,
    range: OffsetRange,
    result: DefinitionResult
  ): void {
    if (requestId !== this.definitionHoverRequestId) return
    if (active !== this.activeDocument) return
    if (
      !preferredJumpableDefinitionTarget(active.uri, active.text, range, result)
    )
      return this.clearDefinitionLink()

    this.linkRange = range
    this.context.setRangeHighlight?.(
      this.linkHighlightName,
      [range],
      LINK_HIGHLIGHT_STYLE
    )
    this.context.scrollElement.style.cursor = "pointer"
  }

  private handleNavigationResult(
    requestId: number,
    active: ActiveDocument,
    offset: number,
    command: TypeScriptLspNavigationCommand,
    result: DefinitionResult
  ): void {
    if (requestId !== this.definitionRequestId) return
    if (active !== this.activeDocument) return

    if (command.kind === "references") {
      this.handleReferencesResult(active, offset, result)
      return
    }

    const target = preferredDefinitionTarget(active.uri, result)
    if (!target) return
    this.openNavigationTarget(active, target, command)
  }

  private handleReferencesResult(
    active: ActiveDocument,
    offset: number,
    result: DefinitionResult
  ): void {
    const handled = this.options.onOpenReferences?.({
      uri: active.uri,
      targets: result.targets,
    })
    if (handled) return

    const target = preferredReferenceTarget(active.uri, active.text, offset, result)
    if (!target) return
    this.openNavigationTarget(active, target, {
      kind: "references",
      openMode: "peek",
    })
  }

  private openNavigationTarget(
    active: ActiveDocument,
    target: TypeScriptLspDefinitionTarget,
    command: TypeScriptLspNavigationCommand
  ): void {
    const shouldOfferExternalOpen =
      target.uri !== active.uri || command.openMode !== "default"
    const handled = shouldOfferExternalOpen
      ? this.openDefinitionTarget(target, command)
      : false
    if (handled) return
    if (target.uri !== active.uri) return

    navigateToTarget(target, {
      text: active.text,
      setSelection: this.context.setSelection.bind(this.context),
      focusEditor: this.context.focusEditor.bind(this.context),
    }, navigationTimingName(command.kind))
  }

  private openDefinitionTarget(
    target: TypeScriptLspDefinitionTarget,
    command: TypeScriptLspNavigationCommand
  ): void | boolean {
    const options = defaultDefinitionOptions(command)
    if (!options) return this.options.onOpenDefinition?.(target)
    return this.options.onOpenDefinition?.(target, options)
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
    hoverMarkdownCodeBackground: options.hoverMarkdownCodeBackground ?? false,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    workerFactory: options.workerFactory,
    webSocketRoute: options.webSocketRoute,
    webSocketTransportOptions: options.webSocketTransportOptions,
    onStatusChange: options.onStatusChange,
    onDiagnostics: options.onDiagnostics,
    onOpenDefinition: options.onOpenDefinition,
    onOpenReferences: options.onOpenReferences,
    onError: options.onError,
  }
}

const TYPESCRIPT_LSP_COMMANDS: readonly {
  readonly id: EditorCommandId
  run(state: TypeScriptLspPluginState): boolean
}[] = [
  {
    id: "goToDefinition",
    run: (state) => state.goToDefinitionFromSelection(),
  },
  {
    id: "editor.action.goToDefinition",
    run: (state) => state.goToDefinitionFromSelection(),
  },
  {
    id: "editor.action.peekDefinition",
    run: (state) =>
      state.runNavigationCommand({ kind: "definition", openMode: "peek" }),
  },
  {
    id: "editor.action.revealDefinitionAside",
    run: (state) =>
      state.runNavigationCommand({ kind: "definition", openMode: "aside" }),
  },
  {
    id: "editor.action.goToImplementation",
    run: (state) =>
      state.runNavigationCommand({
        kind: "implementation",
        openMode: "default",
      }),
  },
  {
    id: "editor.action.goToTypeDefinition",
    run: (state) =>
      state.runNavigationCommand({
        kind: "typeDefinition",
        openMode: "default",
      }),
  },
  {
    id: "editor.action.goToReferences",
    run: (state) =>
      state.runNavigationCommand({
        kind: "references",
        openMode: "peek",
        includeDeclaration: true,
      }),
  },
  {
    id: "editor.action.marker.next",
    run: (state) => state.moveDiagnosticMarker("next"),
  },
  {
    id: "editor.action.marker.prev",
    run: (state) => state.moveDiagnosticMarker("previous"),
  },
]

function defaultDefinitionOptions(
  command: TypeScriptLspNavigationCommand
): TypeScriptLspNavigationOptions | null {
  if (command.kind === "definition" && command.openMode === "default") return null

  return {
    kind: command.kind,
    openMode: command.openMode,
  }
}

function navigationTimingName(kind: TypeScriptLspNavigationKind): string {
  if (kind === "typeDefinition") return "typescriptLsp.goToTypeDefinition"
  return `typescriptLsp.goTo${capitalize(kind)}`
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
  if (!isTypeScriptLspLanguage(snapshot.languageId)) return null

  const uri = pathOrUriToDocumentUri(snapshot.documentId)
  if (!isTypeScriptLspSourceFileName(uri)) return null
  return {
    uri,
    languageId: snapshot.languageId,
    text: snapshot.text,
    textVersion: snapshot.textVersion,
  }
}

function isTypeScriptLspLanguage(languageId: string): boolean {
  return (
    languageId === "javascript" ||
    languageId === "javascriptreact" ||
    languageId === "typescript" ||
    languageId === "typescriptreact"
  )
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

function diagnosticMinimapDecorations(
  lineCount: number,
  diagnostics: readonly lsp.Diagnostic[]
): readonly EditorMinimapDecoration[] {
  const decorations = diagnostics.flatMap((diagnostic) =>
    diagnosticMinimapDecoration(lineCount, diagnostic)
  )
  return decorations
}

function diagnosticMinimapDecoration(
  lineCount: number,
  diagnostic: lsp.Diagnostic
): readonly EditorMinimapDecoration[] {
  if (lineCount <= 0) return []

  const severity = minimapSeverityForDiagnostic(diagnostic)
  const startLineNumber = clampLineNumber(
    diagnostic.range.start.line + 1,
    lineCount
  )
  const endLineNumber = Math.max(
    startLineNumber,
    clampLineNumber(diagnosticEndLineNumber(diagnostic), lineCount)
  )
  return [
    {
      startLineNumber,
      startColumn: 1,
      endLineNumber,
      endColumn: 1,
      color: DIAGNOSTIC_MINIMAP_COLORS[severity],
      position: "inline",
      zIndex: DIAGNOSTIC_MINIMAP_Z_INDEX[severity],
    },
  ]
}

function diagnosticEndLineNumber(diagnostic: lsp.Diagnostic): number {
  const start = diagnostic.range.start
  const end = diagnostic.range.end
  if (end.line > start.line && end.character === 0) return end.line
  return end.line + 1
}

function minimapSeverityForDiagnostic(
  diagnostic: lsp.Diagnostic
): TypeScriptLspDiagnosticSeverity {
  if (diagnostic.severity === LSP_DIAGNOSTIC_WARNING) return "warning"
  if (diagnostic.severity === LSP_DIAGNOSTIC_INFORMATION) return "information"
  if (diagnostic.severity === LSP_DIAGNOSTIC_HINT) return "hint"
  if (diagnostic.severity === LSP_DIAGNOSTIC_ERROR) return "error"
  return "error"
}

function clampLineNumber(lineNumber: number, lineCount: number): number {
  return Math.min(Math.max(1, lineNumber), lineCount)
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

function primaryCollapsedSelection(
  snapshot: EditorViewSnapshot
): EditorViewSnapshot["selections"][number] | null {
  const selection = snapshot.selections[0]
  if (!selection) return null
  if (selection.startOffset !== selection.endOffset) return null
  return selection
}

function diagnosticMarkerTarget(
  text: string,
  diagnostics: readonly lsp.Diagnostic[],
  offset: number,
  direction: DiagnosticMarkerDirection
): OffsetRange | null {
  const ranges = diagnostics
    .flatMap((diagnostic) => diagnosticRange(text, diagnostic))
    .sort(compareOffsetRanges)
  if (ranges.length === 0) return null
  if (direction === "next")
    return ranges.find((range) => range.start > offset) ?? ranges[0] ?? null

  return (
    ranges
      .toReversed()
      .find((range) => range.start < offset) ??
    ranges.at(-1) ??
    null
  )
}

function diagnosticRange(
  text: string,
  diagnostic: lsp.Diagnostic
): readonly OffsetRange[] {
  const start = lspPositionToOffset(text, diagnostic.range.start)
  const end = lspPositionToOffset(text, diagnostic.range.end)
  if (end < start) return []
  return [{ start, end }]
}

function compareOffsetRanges(left: OffsetRange, right: OffsetRange): number {
  return left.start - right.start || left.end - right.end
}

function isNavigationModifier(event: {
  readonly metaKey: boolean
  readonly ctrlKey: boolean
}): boolean {
  return event.metaKey || event.ctrlKey
}

function isCompletionManualTrigger(event: KeyboardEvent): boolean {
  if (!event.ctrlKey && !event.metaKey) return false
  return event.key === " " || event.code === "Space"
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true
  if (!isRecord(error)) return false
  return error.name === "LspRequestCancelledError"
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}
