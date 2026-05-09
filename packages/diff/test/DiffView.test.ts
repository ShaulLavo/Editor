import { beforeAll, describe, expect, it, vi } from "vitest";
import { createTextDiff, DiffView } from "../src";
import type { DiffSplitHandleContext, DiffSplitPaneOptions } from "../src";

beforeAll(() => {
  installHighlightPolyfill();
});

describe("DiffView split panes", () => {
  it("renders old pane, custom handle, then new pane in split mode", () => {
    const createHandle = vi.fn((context: DiffSplitHandleContext) => {
      const handle = context.document.createElement("div");
      handle.className = "diff-custom-handle";
      return handle;
    });
    const { container } = renderDiffView({ createHandle });
    const split = querySplit(container);
    const children = Array.from(split.children);

    expect(children).toHaveLength(3);
    expect(children[0]?.classList.contains("editor-diff-pane-old")).toBe(true);
    expect(children[1]?.classList.contains("diff-custom-handle")).toBe(true);
    expect(children[1]?.getAttribute("role")).toBe("separator");
    expect(children[2]?.classList.contains("editor-diff-pane-new")).toBe(true);
  });

  it("passes file-aware context to custom split handles", () => {
    const createHandle = vi.fn((context: DiffSplitHandleContext) =>
      context.document.createElement("div"),
    );
    renderDiffView({ createHandle });

    expect(createHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        beforePaneId: "old",
        afterPaneId: "new",
        file: expect.objectContaining({ path: "note.txt" }),
        orientation: "horizontal",
      }),
    );
  });

  it("disposes the pane group when switching to stacked mode", () => {
    const { container, diffView } = renderDiffView();

    expect(container.querySelector("[data-editor-pane-handle]")).not.toBeNull();

    diffView.setMode("stacked");

    expect(container.querySelector("[data-editor-pane-handle]")).toBeNull();
    expect(container.querySelector(".editor-diff-split")).toBeNull();
    expect(container.querySelector(".editor-diff-pane-stacked")).not.toBeNull();
  });

  it("reports split layout callbacks with old and new pane ids", () => {
    const onLayoutChange = vi.fn();
    const onLayoutChanged = vi.fn();
    const { container } = renderDiffView({ onLayoutChange, onLayoutChanged });
    const split = querySplit(container);
    const handle = queryHandle(container);
    setRect(split, 1000, 500);

    dispatchPointer(handle, "pointerdown", { clientX: 500 });
    dispatchPointer(container.ownerDocument, "pointermove", { clientX: 600 });
    dispatchPointer(container.ownerDocument, "pointerup", { clientX: 600 });

    expect(onLayoutChange).toHaveBeenCalledWith({ old: 60, new: 40 }, expect.any(Object));
    expect(onLayoutChanged).toHaveBeenCalledWith({ old: 60, new: 40 }, expect.any(Object));
  });
});

type RenderDiffViewOptions = {
  readonly createHandle?: DiffSplitPaneOptions["createHandle"];
  readonly onLayoutChange?: DiffSplitPaneOptions["onLayoutChange"];
  readonly onLayoutChanged?: DiffSplitPaneOptions["onLayoutChanged"];
};

function renderDiffView(options: RenderDiffViewOptions = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const diffView = new DiffView(container, {
    syntaxHighlight: false,
    splitPane: {
      createHandle: options.createHandle,
      onLayoutChange: options.onLayoutChange,
      onLayoutChanged: options.onLayoutChanged,
    },
  });
  diffView.setFiles([
    createTextDiff({
      oldFile: { path: "note.txt", text: "one\ntwo\n" },
      newFile: { path: "note.txt", text: "one\nTWO\n" },
    }),
  ]);
  return { container, diffView };
}

function querySplit(container: HTMLElement): HTMLElement {
  const split = container.querySelector<HTMLElement>(".editor-diff-split");
  if (!split) throw new Error("Expected split diff");
  return split;
}

function queryHandle(container: HTMLElement): HTMLElement {
  const handle = container.querySelector<HTMLElement>("[data-editor-pane-handle]");
  if (!handle) throw new Error("Expected split handle");
  return handle;
}

function setRect(element: HTMLElement, width: number, height: number): void {
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => undefined,
    }) as DOMRect;
}

function dispatchPointer(
  target: EventTarget,
  type: string,
  init: { readonly clientX: number; readonly clientY?: number },
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY ?? 0,
    button: 0,
  });
  target.dispatchEvent(event);
}

type HighlightConstructor = new (...ranges: AbstractRange[]) => Highlight;

class TestHighlight {
  private readonly ranges = new Set<AbstractRange>();

  public constructor(...ranges: AbstractRange[]) {
    for (const range of ranges) this.ranges.add(range);
  }

  public add(range: AbstractRange): this {
    this.ranges.add(range);
    return this;
  }

  public clear(): void {
    this.ranges.clear();
  }

  public delete(range: AbstractRange): boolean {
    return this.ranges.delete(range);
  }
}

function installHighlightPolyfill(): void {
  const global = globalThis as typeof globalThis & {
    Highlight?: HighlightConstructor;
  };
  if (global.Highlight) return;
  global.Highlight = TestHighlight as unknown as HighlightConstructor;
}
