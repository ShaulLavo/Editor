import type { DocumentSessionChange } from "./documentSession";
import type { PieceTableSnapshot } from "./pieceTable/pieceTableTypes";
import type { EditorToken } from "./tokens";
import type { EditorSyntaxLanguageId } from "./syntax/session";

export type EditorDisposable = {
  dispose(): void;
};

export type EditorHighlightResult = {
  readonly tokens: readonly EditorToken[];
};

export type EditorHighlighterSessionOptions = {
  readonly documentId: string;
  readonly languageId: EditorSyntaxLanguageId | null;
  readonly text: string;
  readonly snapshot: PieceTableSnapshot;
};

export type EditorHighlighterSession = EditorDisposable & {
  refresh(snapshot: PieceTableSnapshot, text?: string): Promise<EditorHighlightResult>;
  applyChange(change: DocumentSessionChange): Promise<EditorHighlightResult>;
};

export type EditorHighlighterProvider = {
  createSession(options: EditorHighlighterSessionOptions): EditorHighlighterSession | null;
};

export type EditorPluginContext = {
  registerHighlighter(provider: EditorHighlighterProvider): EditorDisposable;
};

export type EditorPlugin = {
  readonly name?: string;
  activate(context: EditorPluginContext): void | EditorDisposable | readonly EditorDisposable[];
};

export class EditorPluginHost implements EditorDisposable {
  private readonly highlighters: EditorHighlighterProvider[] = [];
  private readonly disposables: EditorDisposable[] = [];

  public constructor(plugins: readonly EditorPlugin[] = []) {
    const context = this.createContext();

    for (const plugin of plugins) {
      this.adoptActivationResult(plugin.activate(context));
    }
  }

  public createHighlighterSession(
    options: EditorHighlighterSessionOptions,
  ): EditorHighlighterSession | null {
    for (const provider of this.highlighters) {
      const session = provider.createSession(options);
      if (session) return session;
    }

    return null;
  }

  public dispose(): void {
    while (this.disposables.length > 0) this.disposables.pop()?.dispose();
    this.highlighters.length = 0;
  }

  private createContext(): EditorPluginContext {
    return {
      registerHighlighter: (provider) => this.registerHighlighter(provider),
    };
  }

  private registerHighlighter(provider: EditorHighlighterProvider): EditorDisposable {
    this.highlighters.push(provider);

    return {
      dispose: () => this.unregisterHighlighter(provider),
    };
  }

  private unregisterHighlighter(provider: EditorHighlighterProvider): void {
    const index = this.highlighters.indexOf(provider);
    if (index === -1) return;

    this.highlighters.splice(index, 1);
  }

  private adoptActivationResult(
    result: void | EditorDisposable | readonly EditorDisposable[],
  ): void {
    if (!result) return;
    if (isDisposableList(result)) {
      this.disposables.push(...result);
      return;
    }

    this.disposables.push(result);
  }
}

const isDisposableList = (
  value: EditorDisposable | readonly EditorDisposable[],
): value is readonly EditorDisposable[] => Array.isArray(value);
