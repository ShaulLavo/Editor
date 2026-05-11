import type { VirtualizedTextView, VirtualizedTextViewState } from "@editor/core";
import {
  diffGutterColor,
  diffGutterText,
  diffGutterWidthCharacters,
  type DiffGutterSide,
} from "./gutters";
import type { DiffRenderRow } from "./types";

export type DiffCanvasGutterRenderer = {
  render(): void;
  refreshStyle(): void;
  dispose(): void;
};

type DiffGutterColors = {
  readonly added: string;
  readonly addedBackground: string;
  readonly deleted: string;
  readonly deletedBackground: string;
  readonly foreground: string;
  readonly hunk: string;
  readonly hunkBackground: string;
  readonly placeholderBackground: string;
};

type DiffGutterEntry = {
  readonly backgroundColor: string;
  readonly color: string;
  readonly text: string;
};

type DiffGutterCanvasStyle = {
  readonly colors: DiffGutterColors;
  readonly font: string;
};

type DiffGutterEntryCache = {
  readonly entries: readonly DiffGutterEntry[];
  readonly rows: readonly DiffRenderRow[];
};

type MountedGutterBounds = {
  readonly height: number;
  readonly top: number;
};

const DEFAULT_ADDED_COLOR = "#5ecc71";
const DEFAULT_ADDED_BACKGROUND = "rgba(94, 204, 113, 0.22)";
const DEFAULT_DELETED_COLOR = "#ff6762";
const DEFAULT_DELETED_BACKGROUND = "rgba(255, 103, 98, 0.22)";
const DEFAULT_FOREGROUND_COLOR = "#71717a";
const DEFAULT_HUNK_COLOR = "#9cdcfe";
const DEFAULT_HUNK_BACKGROUND = "rgba(105, 177, 255, 0.16)";
const DEFAULT_PLACEHOLDER_BACKGROUND = "rgba(255, 255, 255, 0.08)";
const GUTTER_RESERVED_WIDTH = 30;
const GUTTER_PADDING_RIGHT = 6;

export function createDiffCanvasGutterRenderer(
  view: VirtualizedTextView,
  getRows: () => readonly DiffRenderRow[],
  side: DiffGutterSide,
): DiffCanvasGutterRenderer {
  const canvas = view.scrollElement.ownerDocument.createElement("canvas");
  const host = canvasGutterHost(view);
  let style = gutterCanvasStyle(view.scrollElement);
  let cache: DiffGutterEntryCache | null = null;
  canvas.className = "editor-diff-gutter-canvas";
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);

  return {
    render() {
      cache = currentEntryCache(cache, getRows(), side, style.colors);
      renderDiffCanvasGutter(canvas, view, cache, style, side);
    },
    refreshStyle() {
      style = gutterCanvasStyle(view.scrollElement);
      cache = null;
    },
    dispose() {
      canvas.remove();
    },
  };
}

function currentEntryCache(
  cache: DiffGutterEntryCache | null,
  rows: readonly DiffRenderRow[],
  side: DiffGutterSide,
  colors: DiffGutterColors,
): DiffGutterEntryCache {
  if (cache?.rows === rows) return cache;

  return {
    entries: gutterEntries(rows, side, colors),
    rows,
  };
}

function renderDiffCanvasGutter(
  canvas: HTMLCanvasElement,
  view: VirtualizedTextView,
  cache: DiffGutterEntryCache,
  style: DiffGutterCanvasStyle,
  side: DiffGutterSide,
): void {
  const state = view.getState();
  const bounds = mountedGutterBounds(state);
  const width = gutterWidth(state, cache.rows, side);
  positionCanvas(canvas, bounds.top);
  resizeCanvas(canvas, width, bounds.height);

  const context = canvasContext(canvas);
  if (!context) return;

  const scale = deviceScale(canvas);
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, bounds.height);
  if (width <= 0 || bounds.height <= 0) return;

  renderMountedGutterRows(
    context,
    view.getLineStarts(),
    state,
    cache.entries,
    style.font,
    width,
    bounds,
  );
}

function canvasGutterHost(view: VirtualizedTextView): HTMLElement {
  return (
    view.scrollElement.querySelector<HTMLElement>(".editor-virtualized-gutter") ??
    view.scrollElement
  );
}

function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext("2d");
  } catch {
    return null;
  }
}

function renderMountedGutterRows(
  context: CanvasRenderingContext2D,
  lineStarts: readonly number[],
  state: VirtualizedTextViewState,
  entries: readonly DiffGutterEntry[],
  font: string,
  width: number,
  bounds: MountedGutterBounds,
): void {
  applyGutterTextStyle(context, font);

  for (const row of state.mountedRows) {
    if (row.startOffset !== lineStarts[row.bufferRow]) continue;

    const top = row.top - bounds.top;
    drawGutterRow(context, row.bufferRow, top, row.height, entries, width);
  }
}

function mountedGutterBounds(state: VirtualizedTextViewState): MountedGutterBounds {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const row of state.mountedRows) {
    top = Math.min(top, row.top);
    bottom = Math.max(bottom, row.top + row.height);
  }

  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return { height: 0, top: 0 };
  return { height: Math.ceil(bottom - top), top };
}

function drawGutterRow(
  context: CanvasRenderingContext2D,
  rowIndex: number,
  top: number,
  height: number,
  entries: readonly DiffGutterEntry[],
  width: number,
): void {
  const entry = entries[rowIndex];
  if (!entry) return;

  if (entry.backgroundColor) {
    context.fillStyle = entry.backgroundColor;
    context.fillRect(0, top, width, height);
  }
  if (!entry.text) return;
  context.fillStyle = entry.color;
  context.fillText(entry.text, width - GUTTER_PADDING_RIGHT, top + height / 2);
}

function applyGutterTextStyle(context: CanvasRenderingContext2D, font: string): void {
  context.font = font;
  context.textAlign = "right";
  context.textBaseline = "middle";
}

function gutterEntries(
  rows: readonly DiffRenderRow[],
  side: DiffGutterSide,
  colors: DiffGutterColors,
): readonly DiffGutterEntry[] {
  return rows.map((row) => ({
    backgroundColor: diffGutterBackgroundColor(row, side, colors),
    color: diffGutterColor(row, side, colors),
    text: diffGutterText(row, side),
  }));
}

function diffGutterBackgroundColor(
  row: DiffRenderRow,
  side: DiffGutterSide,
  colors: DiffGutterColors,
): string {
  if (row.type === "addition" && side !== "old") return colors.addedBackground;
  if (row.type === "deletion" && side !== "new") return colors.deletedBackground;
  if (row.type === "hunk") return colors.hunkBackground;
  if (row.type === "placeholder") return colors.placeholderBackground;
  return "";
}

function gutterCanvasStyle(element: HTMLElement): DiffGutterCanvasStyle {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return {
    colors: gutterColors(style),
    font: gutterFont(style),
  };
}

function gutterFont(style: CSSStyleDeclaration | undefined): string {
  const fontStyle = style?.fontStyle || "normal";
  const fontVariant = style?.fontVariant || "normal";
  const fontWeight = style?.fontWeight || "400";
  const fontSize = style?.fontSize || "13px";
  const fontFamily = style?.fontFamily || "monospace";
  return `${fontStyle} ${fontVariant} ${fontWeight} ${fontSize} ${fontFamily}`;
}

function gutterColors(style: CSSStyleDeclaration | undefined): DiffGutterColors {
  return {
    added: cssValue(style, "--editor-diff-added", DEFAULT_ADDED_COLOR),
    addedBackground: cssValue(style, "--editor-diff-added-bg", DEFAULT_ADDED_BACKGROUND),
    deleted: cssValue(style, "--editor-diff-deleted", DEFAULT_DELETED_COLOR),
    deletedBackground: cssValue(style, "--editor-diff-deleted-bg", DEFAULT_DELETED_BACKGROUND),
    foreground: cssValue(style, "--editor-gutter-foreground", DEFAULT_FOREGROUND_COLOR),
    hunk: DEFAULT_HUNK_COLOR,
    hunkBackground: cssValue(style, "--editor-diff-hunk-bg", DEFAULT_HUNK_BACKGROUND),
    placeholderBackground: cssValue(
      style,
      "--editor-diff-placeholder-bg",
      DEFAULT_PLACEHOLDER_BACKGROUND,
    ),
  };
}

function cssValue(
  style: CSSStyleDeclaration | undefined,
  property: string,
  fallback: string,
): string {
  return style?.getPropertyValue(property).trim() || fallback;
}

function gutterWidth(
  state: VirtualizedTextViewState,
  rows: readonly DiffRenderRow[],
  side: DiffGutterSide,
): number {
  const characters = diffGutterWidthCharacters(side, rows, state.lineCount);
  return Math.ceil(characters * state.metrics.characterWidth + GUTTER_RESERVED_WIDTH);
}

function positionCanvas(canvas: HTMLCanvasElement, top: number): void {
  const transform = `translateY(${top}px)`;
  if (canvas.style.transform === transform) return;

  canvas.style.transform = transform;
}

function resizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
  const scale = deviceScale(canvas);
  const pixelWidth = Math.max(1, Math.ceil(width * scale));
  const pixelHeight = Math.max(1, Math.ceil(height * scale));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  setCanvasCssSize(canvas, width, height);
}

function setCanvasCssSize(canvas: HTMLCanvasElement, width: number, height: number): void {
  const cssWidth = `${Math.max(0, width)}px`;
  const cssHeight = `${Math.max(0, height)}px`;
  if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth;
  if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
}

function deviceScale(canvas: HTMLCanvasElement): number {
  return canvas.ownerDocument.defaultView?.devicePixelRatio || 1;
}
