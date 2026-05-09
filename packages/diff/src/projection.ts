import type { DiffFile, DiffHunk, DiffHunkLine, DiffInlineRange, DiffRenderRow } from "./types";

export type SplitDiffProjection = {
  readonly leftRows: readonly DiffRenderRow[];
  readonly rightRows: readonly DiffRenderRow[];
  readonly hunkRows: ReadonlyMap<number, number>;
};

export type StackedDiffProjection = {
  readonly rows: readonly DiffRenderRow[];
  readonly hunkRows: ReadonlyMap<number, number>;
};

type ChangeBlock = {
  readonly deletions: readonly DiffHunkLine[];
  readonly additions: readonly DiffHunkLine[];
};

export function createSplitProjection(file: DiffFile): SplitDiffProjection {
  const leftRows: DiffRenderRow[] = [];
  const rightRows: DiffRenderRow[] = [];
  const hunkRows = new Map<number, number>();

  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    hunkRows.set(hunkIndex, leftRows.length);
    pushSplitHunkHeader(leftRows, rightRows, hunk, hunkIndex);
    pushSplitHunkRows(leftRows, rightRows, hunk.lines, hunkIndex);
  }

  if (leftRows.length === 0) pushNoChangesRows(leftRows, rightRows);
  return { leftRows, rightRows, hunkRows };
}

export function createStackedProjection(file: DiffFile): StackedDiffProjection {
  const rows: DiffRenderRow[] = [];
  const hunkRows = new Map<number, number>();

  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    hunkRows.set(hunkIndex, rows.length);
    rows.push(hunkHeaderRow(hunk, hunkIndex));
    pushStackedHunkRows(rows, hunk.lines, hunkIndex);
  }

  if (rows.length === 0) rows.push(emptyRow("No changes"));
  return { rows, hunkRows };
}

function pushSplitHunkHeader(
  leftRows: DiffRenderRow[],
  rightRows: DiffRenderRow[],
  hunk: DiffHunk,
  hunkIndex: number,
): void {
  const row = hunkHeaderRow(hunk, hunkIndex);
  leftRows.push(row);
  rightRows.push(row);
}

function pushSplitHunkRows(
  leftRows: DiffRenderRow[],
  rightRows: DiffRenderRow[],
  lines: readonly DiffHunkLine[],
  hunkIndex: number,
): void {
  let index = 0;
  while (index < lines.length) {
    const nextIndex = pushNextSplitRows(leftRows, rightRows, lines, index, hunkIndex);
    index = Math.max(index + 1, nextIndex);
  }
}

function pushNextSplitRows(
  leftRows: DiffRenderRow[],
  rightRows: DiffRenderRow[],
  lines: readonly DiffHunkLine[],
  index: number,
  hunkIndex: number,
): number {
  const line = lines[index];
  if (!line) return index + 1;
  if (line.type === "context") {
    pushSplitContextLine(leftRows, rightRows, line, hunkIndex);
    return index + 1;
  }

  const blockEnd = firstContextIndex(lines, index);
  pushSplitChangeBlock(leftRows, rightRows, changeBlock(lines, index, blockEnd), hunkIndex);
  return blockEnd;
}

function pushSplitContextLine(
  leftRows: DiffRenderRow[],
  rightRows: DiffRenderRow[],
  line: DiffHunkLine,
  hunkIndex: number,
): void {
  leftRows.push(renderRowFromLine(line, "context", "old", hunkIndex));
  rightRows.push(renderRowFromLine(line, "context", "new", hunkIndex));
}

function pushSplitChangeBlock(
  leftRows: DiffRenderRow[],
  rightRows: DiffRenderRow[],
  block: ChangeBlock,
  hunkIndex: number,
): void {
  const count = Math.max(block.deletions.length, block.additions.length);
  for (let index = 0; index < count; index += 1) {
    leftRows.push(splitDeletionRow(block.deletions[index], hunkIndex));
    rightRows.push(splitAdditionRow(block.additions[index], hunkIndex));
  }
}

function splitDeletionRow(line: DiffHunkLine | undefined, hunkIndex: number): DiffRenderRow {
  if (!line) return placeholderRow(hunkIndex);
  return renderRowFromLine(line, "deletion", "old", hunkIndex, line.oldInlineRanges);
}

function splitAdditionRow(line: DiffHunkLine | undefined, hunkIndex: number): DiffRenderRow {
  if (!line) return placeholderRow(hunkIndex);
  return renderRowFromLine(line, "addition", "new", hunkIndex, line.newInlineRanges);
}

function pushStackedHunkRows(
  rows: DiffRenderRow[],
  lines: readonly DiffHunkLine[],
  hunkIndex: number,
): void {
  for (const line of lines) rows.push(stackedRowFromLine(line, hunkIndex));
}

function stackedRowFromLine(line: DiffHunkLine, hunkIndex: number): DiffRenderRow {
  if (line.type === "deletion") {
    return renderRowFromLine(line, "deletion", "old", hunkIndex, line.oldInlineRanges);
  }
  if (line.type === "addition") {
    return renderRowFromLine(line, "addition", "new", hunkIndex, line.newInlineRanges);
  }

  return renderRowFromLine(line, "context", "both", hunkIndex);
}

function renderRowFromLine(
  line: DiffHunkLine,
  type: "context" | "addition" | "deletion",
  side: "old" | "new" | "both",
  hunkIndex: number,
  inlineRanges: readonly DiffInlineRange[] = [],
): DiffRenderRow {
  return {
    type,
    text: line.text,
    oldLineNumber: side !== "new" ? line.oldLineNumber : undefined,
    newLineNumber: side !== "old" ? line.newLineNumber : undefined,
    hunkIndex,
    inlineRanges,
  };
}

function hunkHeaderRow(hunk: DiffHunk, hunkIndex: number): DiffRenderRow {
  return {
    type: "hunk",
    text: hunk.header,
    hunkIndex,
  };
}

function placeholderRow(hunkIndex: number): DiffRenderRow {
  return {
    type: "placeholder",
    text: "",
    hunkIndex,
  };
}

function emptyRow(text: string): DiffRenderRow {
  return {
    type: "empty",
    text,
  };
}

function pushNoChangesRows(leftRows: DiffRenderRow[], rightRows: DiffRenderRow[]): void {
  leftRows.push(emptyRow("No changes"));
  rightRows.push(emptyRow("No changes"));
}

function firstContextIndex(lines: readonly DiffHunkLine[], start: number): number {
  let index = start;
  while (index < lines.length && lines[index]?.type !== "context") index += 1;
  return index;
}

function changeBlock(lines: readonly DiffHunkLine[], start: number, end: number): ChangeBlock {
  return {
    deletions: lines.slice(start, end).filter((line) => line.type === "deletion"),
    additions: lines.slice(start, end).filter((line) => line.type === "addition"),
  };
}
