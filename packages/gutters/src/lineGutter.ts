import type { EditorGutterContribution, EditorGutterRowContext, EditorPlugin } from "@editor/core";
import { normalizeNonNegativeNumber, normalizePositiveInteger, setElementHidden } from "./utils";
import "./lineGutter.css";

export type LineGutterPluginOptions = {
  readonly counterStyle?: string;
  readonly minLabelColumns?: number;
  readonly minWidth?: number;
};

const DEFAULT_COUNTER_STYLE = "decimal";
const DEFAULT_LINE_GUTTER_MIN_COLUMNS = 3;
const DEFAULT_LINE_GUTTER_MIN_WIDTH = 26;
const LINE_GUTTER_PADDING_PX = 8;

export function createLineGutterPlugin(options: LineGutterPluginOptions = {}): EditorPlugin {
  const contribution = createLineGutterContribution(options);

  return {
    name: "line-gutter",
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

function updateLineGutterCell(element: HTMLElement, row: EditorGutterRowContext): void {
  setElementHidden(element, !row.primaryText);
  element.classList.toggle(
    "editor-virtualized-line-number-active",
    row.primaryText && row.cursorLine && row.cursorLineHighlight.gutterNumber,
  );
  if (!row.primaryText) return;

  setCounterSet(element, `editor-line ${row.bufferRow + 1}`);
}

function setCounterSet(element: HTMLElement, value: string): void {
  if (element.style.counterSet === value) return;
  element.style.counterSet = value;
}

function decimalDigitCount(value: number): number {
  return String(Math.max(1, Math.floor(value))).length;
}
