import type { EditorDocument, EditorToken, EditorTokenStyle, TextEdit } from "./tokens";
import { buildHighlightRule, clamp, normalizeTokenStyle, serializeTokenStyle } from "./style-utils";

let editorInstanceCount = 0;

export function resetEditorInstanceCount(): void {
  editorInstanceCount = 0;
}

/** Minimal interface for the CSS Custom Highlight API registry. */
export interface HighlightRegistry {
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
}

let highlightRegistry: HighlightRegistry | undefined;

/**
 * Override the HighlightRegistry used by all Editor instances.
 * Useful for testing environments where CSS.highlights is unavailable.
 * Pass `undefined` to revert to the default `CSS.highlights`.
 */
export function setHighlightRegistry(registry: HighlightRegistry | undefined): void {
  highlightRegistry = registry;
}

function getHighlightRegistry(): HighlightRegistry {
  return highlightRegistry ?? CSS.highlights;
}

export class Editor {
  private el: HTMLPreElement;
  private readonly textNode: Text;
  private readonly highlightPrefix: string;
  private readonly styleEl: HTMLStyleElement;
  private highlightNames: string[] = [];
  private nextGroupId = 0;
  private trackedTokens: Array<{ start: number; end: number; styleKey: string; range: Range }> = [];
  private groups = new Map<
    string,
    { name: string; highlight: Highlight; style: EditorTokenStyle }
  >();

  constructor(container: HTMLElement) {
    this.el = document.createElement("pre");
    this.el.className = "editor";
    this.textNode = document.createTextNode("");
    this.highlightPrefix = `editor-token-${editorInstanceCount++}`;
    this.styleEl = document.createElement("style");

    this.el.appendChild(this.textNode);
    document.head.appendChild(this.styleEl);
    container.appendChild(this.el);
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

  clear(): void {
    this.setContent("");
  }

  dispose(): void {
    this.clearHighlights();
    this.styleEl.remove();
    this.el.remove();
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
    this.styleEl.textContent = "";
  }

  private rebuildStyleRules() {
    const rules: string[] = [];
    for (const { name, style } of this.groups.values()) rules.push(buildHighlightRule(name, style));
    this.styleEl.textContent = rules.join("\n");
  }
}
