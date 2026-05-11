import type { EditorGutterContribution } from "@editor/core";
import type { DiffRenderRow } from "./types";

export type DiffGutterSide = "old" | "new" | "stacked";

const MIN_LINE_NUMBER_DIGITS = 2;
const GUTTER_RESERVED_WIDTH = 30;

export function createDiffGutterContribution(
  side: DiffGutterSide,
  getRows: () => readonly DiffRenderRow[],
): EditorGutterContribution {
  return {
    id: `diff-${side}-gutter`,
    className: "editor-diff-gutter-cell",
    createCell(document) {
      return createDiffGutterCell(document);
    },
    width(context) {
      const characters = diffGutterWidthCharacters(side, getRows(), context.lineCount);
      return Math.ceil(characters * context.metrics.characterWidth + GUTTER_RESERVED_WIDTH);
    },
    updateCell() {},
  };
}

export function diffGutterWidthCharacters(
  side: DiffGutterSide,
  rows: readonly DiffRenderRow[],
  lineCount: number,
): number {
  let maxCharacters = String(Math.max(1, lineCount)).length;
  for (const row of rows) {
    maxCharacters = Math.max(maxCharacters, lineNumberForRow(row, side).length);
  }

  return Math.max(MIN_LINE_NUMBER_DIGITS, maxCharacters);
}

function createDiffGutterCell(document: Document): HTMLElement {
  const element = document.createElement("span");
  element.className = "editor-diff-gutter";
  element.setAttribute("aria-hidden", "true");
  return element;
}

export function diffGutterText(row: DiffRenderRow, side: DiffGutterSide): string {
  const indicator = indicatorForRow(row, side);
  const number = lineNumberForRow(row, side);
  if (indicator && number) return `${indicator} ${number}`;
  return indicator || number;
}

export function diffGutterColor(
  row: DiffRenderRow,
  side: DiffGutterSide,
  colors: {
    readonly added: string;
    readonly deleted: string;
    readonly foreground: string;
    readonly hunk: string;
  },
): string {
  if (row.type === "addition" && side !== "old") return colors.added;
  if (row.type === "deletion" && side !== "new") return colors.deleted;
  if (row.type === "hunk") return colors.hunk;
  return colors.foreground;
}

function indicatorForRow(row: DiffRenderRow, side: DiffGutterSide): string {
  if (row.type === "addition" && side !== "old") return "+";
  if (row.type === "deletion" && side !== "new") return "-";
  if (row.type === "hunk" && row.expandable) return row.expanded ? "−" : "+";
  return "";
}

function lineNumberForRow(row: DiffRenderRow, side: DiffGutterSide): string {
  if (row.type === "hunk" || row.type === "empty") return "";
  if (side === "old") return formatLineNumber(row.oldLineNumber);
  if (side === "new") return formatLineNumber(row.newLineNumber);
  return formatStackedLineNumber(row);
}

function formatStackedLineNumber(row: DiffRenderRow): string {
  const oldNumber = formatLineNumber(row.oldLineNumber);
  const newNumber = formatLineNumber(row.newLineNumber);
  if (oldNumber && newNumber) return `${oldNumber}/${newNumber}`;
  return oldNumber || newNumber;
}

function formatLineNumber(value: number | undefined): string {
  if (value === undefined) return "";
  return String(value);
}
