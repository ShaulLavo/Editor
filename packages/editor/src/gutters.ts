import type { EditorGutterContribution, EditorGutterRowContext, EditorPlugin } from "./plugins";

export type LineGutterPluginOptions = {
  readonly counterStyle?: string;
  readonly minLabelColumns?: number;
  readonly minWidth?: number;
};

export type FoldGutterPluginOptions = {
  readonly width?: number;
  readonly expandedIndicator?: string;
  readonly collapsedIndicator?: string;
};

const DEFAULT_COUNTER_STYLE = "decimal";
const DEFAULT_LINE_GUTTER_MIN_COLUMNS = 3;
const DEFAULT_LINE_GUTTER_MIN_WIDTH = 26;
const LINE_GUTTER_PADDING_PX = 8;
const DEFAULT_FOLD_GUTTER_WIDTH = 10;
const DEFAULT_EXPANDED_INDICATOR = "v";
const DEFAULT_COLLAPSED_INDICATOR = ">";

export function createLineGutterPlugin(options: LineGutterPluginOptions = {}): EditorPlugin {
  const contribution = createLineGutterContribution(options);

  return {
    name: "line-gutter",
    activate(context) {
      return context.registerGutterContribution(contribution);
    },
  };
}

export function createFoldGutterPlugin(options: FoldGutterPluginOptions = {}): EditorPlugin {
  const contribution = createFoldGutterContribution(options);

  return {
    name: "fold-gutter",
    activate(context) {
      return context.registerGutterContribution(contribution);
    },
  };
}

export function createLineGutterContribution(
  options: LineGutterPluginOptions = {},
): EditorGutterContribution {
  const counterStyle = options.counterStyle ?? DEFAULT_COUNTER_STYLE;
  const minLabelColumns = normalizePositiveInteger(
    options.minLabelColumns,
    DEFAULT_LINE_GUTTER_MIN_COLUMNS,
  );
  const minWidth = normalizeNonNegativeNumber(options.minWidth, DEFAULT_LINE_GUTTER_MIN_WIDTH);

  return {
    id: "line-gutter",
    createCell(document) {
      const element = document.createElement("span");
      element.className = "editor-virtualized-gutter-label editor-virtualized-line-number";
      element.setAttribute("aria-hidden", "true");
      element.style.setProperty("--editor-line-gutter-counter-style", counterStyle);
      return element;
    },
    width(context) {
      const columns = Math.max(minLabelColumns, decimalDigitCount(context.lineCount));
      return Math.max(
        minWidth,
        Math.ceil(columns * context.metrics.characterWidth + LINE_GUTTER_PADDING_PX),
      );
    },
    updateCell(element, row) {
      updateLineGutterCell(element, row);
    },
  };
}

export function createFoldGutterContribution(
  options: FoldGutterPluginOptions = {},
): EditorGutterContribution {
  const width = normalizeNonNegativeNumber(options.width, DEFAULT_FOLD_GUTTER_WIDTH);
  const expandedIndicator = options.expandedIndicator ?? DEFAULT_EXPANDED_INDICATOR;
  const collapsedIndicator = options.collapsedIndicator ?? DEFAULT_COLLAPSED_INDICATOR;

  return {
    id: "fold-gutter",
    createCell(document) {
      const button = document.createElement("button");
      button.className = "editor-virtualized-fold-toggle";
      button.type = "button";
      button.hidden = true;
      button.disabled = true;
      button.tabIndex = -1;
      button.addEventListener("mousedown", preventFoldButtonMouseDown);
      return button;
    },
    width() {
      return width;
    },
    updateCell(element, row) {
      if (!(element instanceof HTMLButtonElement)) return;
      updateFoldGutterButton(element, row, expandedIndicator, collapsedIndicator);
    },
    disposeCell(element) {
      if (!(element instanceof HTMLButtonElement)) return;
      element.onclick = null;
      element.removeEventListener("mousedown", preventFoldButtonMouseDown);
    },
  };
}

function updateLineGutterCell(element: HTMLElement, row: EditorGutterRowContext): void {
  setElementHidden(element, !row.primaryText);
  if (!row.primaryText) return;

  setCounterSet(element, `editor-line ${row.bufferRow + 1}`);
}

function updateFoldGutterButton(
  button: HTMLButtonElement,
  row: EditorGutterRowContext,
  expandedIndicator: string,
  collapsedIndicator: string,
): void {
  const marker = row.foldMarker;
  if (!marker) {
    hideFoldButton(button);
    return;
  }

  const state = marker.collapsed ? "collapsed" : "expanded";
  const indicator = marker.collapsed ? collapsedIndicator : expandedIndicator;
  showFoldButton(button, marker.key, state, indicator);
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    row.toggleFold(marker);
  };
}

function hideFoldButton(button: HTMLButtonElement): void {
  setElementHidden(button, true);
  if (!button.disabled) button.disabled = true;
  if (button.tabIndex !== -1) button.tabIndex = -1;
  button.onclick = null;
  delete button.dataset.editorFoldKey;
  delete button.dataset.editorFoldState;
  delete button.dataset.editorFoldIndicator;
  button.removeAttribute("aria-label");
}

function showFoldButton(
  button: HTMLButtonElement,
  key: string,
  state: "collapsed" | "expanded",
  indicator: string,
): void {
  const label = state === "collapsed" ? "Expand folded region" : "Collapse foldable region";
  setElementHidden(button, false);
  if (button.disabled) button.disabled = false;
  if (button.tabIndex !== 0) button.tabIndex = 0;
  button.dataset.editorFoldKey = key;
  button.dataset.editorFoldState = state;
  button.dataset.editorFoldIndicator = indicator;
  button.setAttribute("aria-label", label);
}

function preventFoldButtonMouseDown(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function setElementHidden(element: HTMLElement, hidden: boolean): void {
  if (element.hidden === hidden) return;
  element.hidden = hidden;
}

function setCounterSet(element: HTMLElement, value: string): void {
  if (element.style.counterSet === value) return;
  element.style.counterSet = value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
  return Math.floor(value);
}

function normalizeNonNegativeNumber(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value < 0) return fallback;
  return value;
}

function decimalDigitCount(value: number): number {
  return String(Math.max(1, Math.floor(value))).length;
}
