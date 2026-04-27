import type { PieceTableSnapshot } from "../pieceTable";
import { forEachPieceTableTextChunk } from "../pieceTable/reads";
import type {
  PosttextLayout,
  PosttextLineBoundary,
  PosttextLineChunk,
  PosttextLineIndex,
  PosttextLineLayout,
  PosttextLineRun,
  PosttextLayoutMetrics,
  PosttextRangeBox,
  PosttextRect,
  PosttextTextEdit,
  PosttextViewport,
  PosttextViewportLine,
  PosttextViewportResult,
  PosttextXY,
} from "./types";

type LocatedLine = {
  runIndex: number;
  lineIndex: number;
  row: number;
  startOffset: number;
  line: PosttextLineLayout;
};

type InlineVisibleRange = {
  startOffset: number;
  endOffset: number;
};

type LineTextBuilder = {
  segments: string[];
  length: number;
};

export type NoWrapPosttextLayoutBuildProfile = {
  layout: PosttextLayout;
  buildLinesMs: number;
  createRunsMs: number;
  totalMs: number;
};

const LINE_RUN_SIZE = 256;
const LINE_CHUNK_SIZE = 1_024;

const assertPositiveMetric = (name: string, value: number) => {
  if (Number.isFinite(value) && value > 0) return;
  throw new RangeError(`${name} must be a positive finite number`);
};

const normalizeMetrics = (metrics: PosttextLayoutMetrics): PosttextLayoutMetrics => {
  assertPositiveMetric("charWidth", metrics.charWidth);
  assertPositiveMetric("lineHeight", metrics.lineHeight);
  assertPositiveMetric("tabSize", metrics.tabSize);
  return metrics;
};

const tabAdvanceColumns = (visualColumn: number, tabSize: number): number => {
  const remainder = visualColumn % tabSize;
  if (remainder === 0) return tabSize;
  return tabSize - remainder;
};

const characterAdvanceColumns = (
  character: string,
  visualColumn: number,
  tabSize: number,
): number => {
  if (character === "\t") return tabAdvanceColumns(visualColumn, tabSize);
  return 1;
};

const scanChunkBoundaries = (
  text: string,
  start: number,
  end: number,
  startColumn: number,
  metrics: PosttextLayoutMetrics,
): { boundaries: PosttextLineBoundary[]; endColumn: number } => {
  const boundaries: PosttextLineBoundary[] = [{ offset: 0, x: 0 }];
  let visualColumn = startColumn;

  for (let index = start; index < end; index += 1) {
    const character = text[index] ?? "";
    visualColumn += characterAdvanceColumns(character, visualColumn, metrics.tabSize);
    boundaries.push({
      offset: index - start + 1,
      x: (visualColumn - startColumn) * metrics.charWidth,
    });
  }

  return { boundaries, endColumn: visualColumn };
};

const createLineChunk = (
  text: string,
  scanStart: number,
  chunkStartOffset: number,
  startColumn: number,
  x: number,
  metrics: PosttextLayoutMetrics,
): PosttextLineChunk => {
  const scanEnd = Math.min(text.length, scanStart + LINE_CHUNK_SIZE);
  const scan = scanChunkBoundaries(text, scanStart, scanEnd, startColumn, metrics);
  const tabIndex = text.indexOf("\t", scanStart);

  return {
    startOffset: chunkStartOffset,
    length: scanEnd - scanStart,
    x,
    width: (scan.endColumn - startColumn) * metrics.charWidth,
    startColumn,
    endColumn: scan.endColumn,
    hasTabs: tabIndex !== -1 && tabIndex < scanEnd,
    boundaries: scan.boundaries,
  };
};

const createLineChunks = (
  text: string,
  metrics: PosttextLayoutMetrics,
  baseOffset = 0,
  baseColumn = 0,
  baseX = 0,
): PosttextLineChunk[] => {
  const chunks: PosttextLineChunk[] = [];
  let scanStart = 0;
  let chunkStartOffset = baseOffset;
  let startColumn = baseColumn;
  let x = baseX;

  if (text.length === 0) {
    chunks.push(createLineChunk(text, 0, baseOffset, baseColumn, baseX, metrics));
    return chunks;
  }

  while (scanStart < text.length) {
    const chunk = createLineChunk(text, scanStart, chunkStartOffset, startColumn, x, metrics);
    chunks.push(chunk);
    scanStart += chunk.length;
    chunkStartOffset += chunk.length;
    startColumn = chunk.endColumn;
    x += chunk.width;
  }

  return chunks;
};

const createPreparedLine = (
  text: string,
  breakLength: number,
  metrics: PosttextLayoutMetrics,
): PosttextLineLayout => {
  const chunks = createLineChunks(text, metrics);
  const lastChunk = chunks[chunks.length - 1] as PosttextLineChunk;

  return {
    text,
    length: text.length,
    breakLength,
    chunks,
    width: lastChunk.x + lastChunk.width,
  };
};

const createLineTextBuilder = (): LineTextBuilder => ({
  segments: [],
  length: 0,
});

const isEmptyLineTextBuilder = (builder: LineTextBuilder): boolean => {
  if (builder.length !== 0) return false;
  return builder.segments.length === 0;
};

const appendLineText = (
  builder: LineTextBuilder,
  text: string,
  start: number,
  end: number,
): void => {
  if (end <= start) return;
  builder.segments.push(text.slice(start, end));
  builder.length += end - start;
};

const lineTextFromBuilder = (builder: LineTextBuilder): string => {
  if (builder.segments.length === 0) return "";
  if (builder.segments.length === 1) return builder.segments[0] ?? "";
  return builder.segments.join("");
};

const pushPreparedLineFromBuilder = (
  lines: PosttextLineLayout[],
  builder: LineTextBuilder,
  breakLength: number,
  metrics: PosttextLayoutMetrics,
): LineTextBuilder => {
  lines.push(createPreparedLine(lineTextFromBuilder(builder), breakLength, metrics));
  return createLineTextBuilder();
};

const pushSingleSegmentLine = (
  lines: PosttextLineLayout[],
  text: string,
  start: number,
  end: number,
  breakLength: number,
  metrics: PosttextLayoutMetrics,
): void => {
  lines.push(createPreparedLine(text.slice(start, end), breakLength, metrics));
};

const appendChunkLines = (
  lines: PosttextLineLayout[],
  builder: LineTextBuilder,
  text: string,
  start: number,
  end: number,
  metrics: PosttextLayoutMetrics,
): LineTextBuilder => {
  let nextBuilder = builder;
  let segmentStart = start;
  let lineBreak = text.indexOf("\n", segmentStart);

  while (lineBreak !== -1 && lineBreak < end) {
    if (isEmptyLineTextBuilder(nextBuilder)) {
      pushSingleSegmentLine(lines, text, segmentStart, lineBreak, 1, metrics);
    } else {
      appendLineText(nextBuilder, text, segmentStart, lineBreak);
      nextBuilder = pushPreparedLineFromBuilder(lines, nextBuilder, 1, metrics);
    }

    segmentStart = lineBreak + 1;
    lineBreak = text.indexOf("\n", segmentStart);
  }

  appendLineText(nextBuilder, text, segmentStart, end);
  return nextBuilder;
};

const prepareLinesFromText = (
  text: string,
  metrics: PosttextLayoutMetrics,
  finalBreakLength: number,
): PosttextLineLayout[] => {
  const lineTexts = text.split("\n");
  const lines: PosttextLineLayout[] = [];

  for (let index = 0; index < lineTexts.length; index += 1) {
    const lineText = lineTexts[index] ?? "";
    const breakLength = index === lineTexts.length - 1 ? finalBreakLength : 1;
    lines.push(createPreparedLine(lineText, breakLength, metrics));
  }

  return lines;
};

const buildLines = (
  snapshot: PieceTableSnapshot,
  metrics: PosttextLayoutMetrics,
): PosttextLineLayout[] => {
  const lines: PosttextLineLayout[] = [];
  let builder = createLineTextBuilder();

  forEachPieceTableTextChunk(snapshot, (text, start, end) => {
    builder = appendChunkLines(lines, builder, text, start, end, metrics);
  });

  pushPreparedLineFromBuilder(lines, builder, 0, metrics);
  return lines;
};

const lineExtent = (line: PosttextLineLayout): number => line.length + line.breakLength;

const linesTextLength = (
  lines: readonly PosttextLineLayout[],
  firstLine: number,
  lineCount: number,
): number => {
  let length = 0;

  for (let index = 0; index < lineCount; index += 1) {
    length += lineExtent(lines[firstLine + index] as PosttextLineLayout);
  }

  return length;
};

const linesWidth = (
  lines: readonly PosttextLineLayout[],
  firstLine: number,
  lineCount: number,
): number => {
  let width = 0;

  for (let index = 0; index < lineCount; index += 1) {
    const line = lines[firstLine + index] as PosttextLineLayout;
    width = Math.max(width, line.width);
  }

  return width;
};

const createRun = (
  lines: readonly PosttextLineLayout[],
  firstLine: number,
  lineCount: number,
  startRow: number,
  startOffset: number,
): PosttextLineRun => ({
  startRow,
  startOffset,
  lines,
  firstLine,
  lineCount,
  textLength: linesTextLength(lines, firstLine, lineCount),
  width: linesWidth(lines, firstLine, lineCount),
});

const createRunsFromLines = (
  lines: readonly PosttextLineLayout[],
  startRow: number,
  startOffset: number,
): PosttextLineRun[] => {
  const runs: PosttextLineRun[] = [];
  let row = startRow;
  let offset = startOffset;

  for (let index = 0; index < lines.length; index += LINE_RUN_SIZE) {
    const lineCount = Math.min(LINE_RUN_SIZE, lines.length - index);
    const run = createRun(lines, index, lineCount, row, offset);
    runs.push(run);
    row += run.lineCount;
    offset += run.textLength;
  }

  return runs;
};

const createLineIndex = (runs: readonly PosttextLineRun[]): PosttextLineIndex => {
  let lineCount = 0;
  let textLength = 0;

  for (const run of runs) {
    lineCount += run.lineCount;
    textLength += run.textLength;
  }

  return { runs, lineCount, textLength };
};

const nowMs = (): number => globalThis.performance?.now() ?? Date.now();

const lineInRun = (run: PosttextLineRun, lineIndex: number): PosttextLineLayout => {
  return run.lines[run.firstLine + lineIndex] as PosttextLineLayout;
};

const layoutFromRuns = (
  snapshot: PieceTableSnapshot,
  metrics: PosttextLayoutMetrics,
  runs: readonly PosttextLineRun[],
): PosttextLayout => {
  const lineIndex = createLineIndex(runs);
  const width = runs.reduce((maxWidth, run) => Math.max(maxWidth, run.width), 0);

  return {
    snapshot,
    metrics,
    lineIndex,
    width,
    height: lineIndex.lineCount * metrics.lineHeight,
  };
};

const clampOffset = (layout: PosttextLayout, offset: number): number => {
  if (offset < 0) return 0;
  if (offset > layout.snapshot.length) return layout.snapshot.length;
  return offset;
};

const lineEndOffset = (located: LocatedLine): number => located.startOffset + located.line.length;

const lineY = (layout: PosttextLayout, row: number): number => row * layout.metrics.lineHeight;

const findRunIndexByRow = (layout: PosttextLayout, row: number): number => {
  const clampedRow = Math.max(0, Math.min(row, layout.lineIndex.lineCount - 1));
  let low = 0;
  let high = layout.lineIndex.runs.length - 1;
  let candidate = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const run = layout.lineIndex.runs[middle] as PosttextLineRun;

    if (run.startRow <= clampedRow) {
      candidate = middle;
      low = middle + 1;
      continue;
    }

    high = middle - 1;
  }

  return candidate;
};

const findRunIndexByOffset = (layout: PosttextLayout, offset: number): number => {
  const clampedOffset = clampOffset(layout, offset);
  let low = 0;
  let high = layout.lineIndex.runs.length - 1;
  let candidate = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const run = layout.lineIndex.runs[middle] as PosttextLineRun;

    if (run.startOffset <= clampedOffset) {
      candidate = middle;
      low = middle + 1;
      continue;
    }

    high = middle - 1;
  }

  return candidate;
};

const locateLineInRunByRow = (run: PosttextLineRun, runIndex: number, row: number): LocatedLine => {
  const lineIndex = Math.max(0, Math.min(row - run.startRow, run.lineCount - 1));
  let startOffset = run.startOffset;

  for (let index = 0; index < lineIndex; index += 1) {
    startOffset += lineExtent(lineInRun(run, index));
  }

  return {
    runIndex,
    lineIndex,
    row: run.startRow + lineIndex,
    startOffset,
    line: lineInRun(run, lineIndex),
  };
};

const locateLineInRunByOffset = (
  run: PosttextLineRun,
  runIndex: number,
  offset: number,
): LocatedLine => {
  let startOffset = run.startOffset;

  for (let lineIndex = 0; lineIndex < run.lineCount; lineIndex += 1) {
    const line = lineInRun(run, lineIndex);
    const endOffset = startOffset + line.length;
    if (offset <= endOffset) {
      return {
        runIndex,
        lineIndex,
        row: run.startRow + lineIndex,
        startOffset,
        line,
      };
    }

    startOffset = endOffset + line.breakLength;
  }

  return locateLineInRunByRow(run, runIndex, run.startRow + run.lineCount - 1);
};

const locateLineByRow = (layout: PosttextLayout, row: number): LocatedLine => {
  const runIndex = findRunIndexByRow(layout, row);
  const run = layout.lineIndex.runs[runIndex] as PosttextLineRun;
  return locateLineInRunByRow(run, runIndex, row);
};

const locateLineByOffset = (layout: PosttextLayout, offset: number): LocatedLine => {
  const clampedOffset = clampOffset(layout, offset);
  const runIndex = findRunIndexByOffset(layout, clampedOffset);
  const run = layout.lineIndex.runs[runIndex] as PosttextLineRun;
  return locateLineInRunByOffset(run, runIndex, clampedOffset);
};

const chunkEndX = (chunk: PosttextLineChunk): number => chunk.x + chunk.width;

const chunkIndexForOffset = (line: PosttextLineLayout, localOffset: number): number => {
  const clampedOffset = Math.max(0, Math.min(localOffset, line.length));
  let low = 0;
  let high = line.chunks.length - 1;
  let candidate = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const chunk = line.chunks[middle] as PosttextLineChunk;

    if (chunk.startOffset <= clampedOffset) {
      candidate = middle;
      low = middle + 1;
      continue;
    }

    high = middle - 1;
  }

  return candidate;
};

const chunkForOffset = (line: PosttextLineLayout, localOffset: number): PosttextLineChunk => {
  return line.chunks[chunkIndexForOffset(line, localOffset)] as PosttextLineChunk;
};

const chunkForX = (line: PosttextLineLayout, x: number): PosttextLineChunk => {
  if (x <= 0) return line.chunks[0] as PosttextLineChunk;
  if (x >= line.width) return line.chunks[line.chunks.length - 1] as PosttextLineChunk;

  for (const chunk of line.chunks) {
    if (x <= chunkEndX(chunk)) return chunk;
  }

  return line.chunks[line.chunks.length - 1] as PosttextLineChunk;
};

const xForOffsetInLine = (located: LocatedLine, offset: number): number => {
  const localOffset = Math.max(0, Math.min(offset - located.startOffset, located.line.length));
  const chunk = chunkForOffset(located.line, localOffset);
  const boundary = chunk.boundaries[localOffset - chunk.startOffset];
  return chunk.x + (boundary?.x ?? chunk.width);
};

const firstBoundaryIndexWithXGreaterThan = (
  boundaries: readonly PosttextLineBoundary[],
  x: number,
): number => {
  let low = 0;
  let high = boundaries.length - 1;
  let result = boundaries.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const boundary = boundaries[middle] as PosttextLineBoundary;

    if (boundary.x > x) {
      result = middle;
      high = middle - 1;
      continue;
    }

    low = middle + 1;
  }

  return result;
};

const firstBoundaryIndexWithXAtLeast = (
  boundaries: readonly PosttextLineBoundary[],
  x: number,
): number => {
  let low = 0;
  let high = boundaries.length - 1;
  let result = boundaries.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const boundary = boundaries[middle] as PosttextLineBoundary;

    if (boundary.x >= x) {
      result = middle;
      high = middle - 1;
      continue;
    }

    low = middle + 1;
  }

  return result;
};

const offsetInsideCell = (
  x: number,
  start: PosttextLineBoundary,
  end: PosttextLineBoundary,
): number => {
  const midpoint = start.x + (end.x - start.x) / 2;
  if (x < midpoint) return start.offset;
  return end.offset;
};

const offsetForXInLine = (located: LocatedLine, x: number): number => {
  if (x <= 0) return located.startOffset;
  if (x >= located.line.width) return lineEndOffset(located);

  const chunk = chunkForX(located.line, x);
  const chunkX = x - chunk.x;
  const endIndex = firstBoundaryIndexWithXGreaterThan(chunk.boundaries, chunkX);
  const start = chunk.boundaries[endIndex - 1] as PosttextLineBoundary;
  const end = chunk.boundaries[endIndex] as PosttextLineBoundary;
  return located.startOffset + chunk.startOffset + offsetInsideCell(chunkX, start, end);
};

const visibleStartLocalOffset = (line: PosttextLineLayout, x: number): number => {
  if (x <= 0) return 0;
  if (x >= line.width) return line.length;

  const chunk = chunkForX(line, x);
  const index = Math.max(0, firstBoundaryIndexWithXGreaterThan(chunk.boundaries, x - chunk.x) - 1);
  const boundary = chunk.boundaries[index] as PosttextLineBoundary;
  return chunk.startOffset + boundary.offset;
};

const visibleEndLocalOffset = (line: PosttextLineLayout, x: number): number => {
  if (x <= 0) return 0;
  if (x >= line.width) return line.length;

  const chunk = chunkForX(line, x);
  const index = firstBoundaryIndexWithXAtLeast(chunk.boundaries, x - chunk.x);
  const boundary = chunk.boundaries[index] as PosttextLineBoundary;
  return chunk.startOffset + boundary.offset;
};

const visibleInlineRange = (
  located: LocatedLine,
  viewport: PosttextViewport,
): InlineVisibleRange => {
  const startOffset = located.startOffset + visibleStartLocalOffset(located.line, viewport.x1);
  const endOffset = located.startOffset + visibleEndLocalOffset(located.line, viewport.x2);

  if (endOffset >= startOffset) return { startOffset, endOffset };

  return {
    startOffset: located.startOffset,
    endOffset: located.startOffset,
  };
};

const lineIntersectsViewport = (
  layout: PosttextLayout,
  located: LocatedLine,
  viewport: PosttextViewport,
): boolean => {
  const y = lineY(layout, located.row);
  if (viewport.y2 <= y) return false;
  return viewport.y1 < y + layout.metrics.lineHeight;
};

const lineIntersectsViewportX = (located: LocatedLine, viewport: PosttextViewport): boolean => {
  if (viewport.x2 <= 0) return false;
  if (located.line.width === 0) return viewport.x1 <= 0;
  return viewport.x1 < located.line.width;
};

const rectForLineRange = (
  layout: PosttextLayout,
  located: LocatedLine,
  startOffset: number,
  endOffset: number,
): PosttextRect => {
  const x = xForOffsetInLine(located, startOffset);
  const endX = xForOffsetInLine(located, endOffset);

  return {
    x,
    y: lineY(layout, located.row),
    width: endX - x,
    height: layout.metrics.lineHeight,
  };
};

const viewportLineForLine = (
  layout: PosttextLayout,
  located: LocatedLine,
  viewport: PosttextViewport,
): PosttextViewportLine | null => {
  if (!lineIntersectsViewport(layout, located, viewport)) return null;
  if (!lineIntersectsViewportX(located, viewport)) return null;
  const range = visibleInlineRange(located, viewport);
  const rect = rectForLineRange(layout, located, range.startOffset, range.endOffset);

  return {
    row: located.row,
    startOffset: located.startOffset,
    endOffset: lineEndOffset(located),
    visibleStartOffset: range.startOffset,
    visibleEndOffset: range.endOffset,
    rect,
  };
};

const normalizeRange = (
  layout: PosttextLayout,
  startOffset: number,
  endOffset: number,
): [number, number] => {
  const start = clampOffset(layout, Math.min(startOffset, endOffset));
  const end = clampOffset(layout, Math.max(startOffset, endOffset));
  return [start, end];
};

const compareEditsAscending = (left: PosttextTextEdit, right: PosttextTextEdit): number => {
  if (left.from !== right.from) return left.from - right.from;
  return left.to - right.to;
};

const compareEditsDescending = (left: PosttextTextEdit, right: PosttextTextEdit): number => {
  if (left.from !== right.from) return right.from - left.from;
  return right.to - left.to;
};

const validateLayoutEdits = (layout: PosttextLayout, edits: readonly PosttextTextEdit[]): void => {
  let previousEnd = -1;
  const sorted = edits.toSorted(compareEditsAscending);

  for (const edit of sorted) {
    if (edit.from < 0 || edit.to < edit.from || edit.to > layout.snapshot.length) {
      throw new RangeError("invalid layout edit range");
    }

    if (edit.from < previousEnd) throw new RangeError("layout edits must not overlap");
    previousEnd = edit.to;
  }
};

const linePrefix = (located: LocatedLine, offset: number): string => {
  const end = Math.max(0, Math.min(offset - located.startOffset, located.line.length));
  return located.line.text.slice(0, end);
};

const lineSuffix = (located: LocatedLine, offset: number): string => {
  const start = Math.max(0, Math.min(offset - located.startOffset, located.line.length));
  return located.line.text.slice(start);
};

const sliceRun = (
  run: PosttextLineRun,
  firstLine: number,
  lineCount: number,
  startRow: number,
  startOffset: number,
): PosttextLineRun | null => {
  if (lineCount <= 0) return null;
  return createRun(run.lines, run.firstLine + firstLine, lineCount, startRow, startOffset);
};

const pushRun = (runs: PosttextLineRun[], run: PosttextLineRun | null): void => {
  if (!run) return;
  runs.push(run);
};

const adjustedRuns = (
  runs: readonly PosttextLineRun[],
  rowDelta: number,
  offsetDelta: number,
): PosttextLineRun[] => {
  if (rowDelta === 0 && offsetDelta === 0) return [...runs];

  return runs.map((run) => ({
    ...run,
    startRow: run.startRow + rowDelta,
    startOffset: run.startOffset + offsetDelta,
  }));
};

const replacementLinesForEdit = (
  layout: PosttextLayout,
  start: LocatedLine,
  end: LocatedLine,
  edit: PosttextTextEdit,
): PosttextLineLayout[] => {
  const preparedText = `${linePrefix(start, edit.from)}${edit.text}${lineSuffix(end, edit.to)}`;
  return prepareLinesFromText(preparedText, layout.metrics, end.line.breakLength);
};

const editedLineChunks = (
  line: PosttextLineLayout,
  localFrom: number,
  localTo: number,
  text: string,
  metrics: PosttextLayoutMetrics,
): readonly PosttextLineChunk[] => {
  const chunkIndex = chunkIndexForOffset(line, localFrom);
  const firstChangedChunk = line.chunks[chunkIndex] as PosttextLineChunk;
  const unchangedChunks = line.chunks.slice(0, chunkIndex);
  const firstChangedChunkEnd = firstChangedChunk.startOffset + firstChangedChunk.length;
  if (localTo > firstChangedChunkEnd) {
    return rebuildChunksFromChangedChunk(line, localFrom, localTo, text, metrics);
  }

  const editedChunkText = `${line.text.slice(firstChangedChunk.startOffset, localFrom)}${text}${line.text.slice(
    localTo,
    firstChangedChunkEnd,
  )}`;
  const editedChunks = createLineChunks(
    editedChunkText,
    metrics,
    firstChangedChunk.startOffset,
    firstChangedChunk.startColumn,
    firstChangedChunk.x,
  );

  return [
    ...unchangedChunks,
    ...editedChunks,
    ...repairFollowingChunks(
      line,
      chunkIndex + 1,
      editedChunks,
      localTo - localFrom,
      text.length,
      metrics,
    ),
  ];
};

const rebuildChunksFromChangedChunk = (
  line: PosttextLineLayout,
  localFrom: number,
  localTo: number,
  text: string,
  metrics: PosttextLayoutMetrics,
): readonly PosttextLineChunk[] => {
  const chunkIndex = chunkIndexForOffset(line, localFrom);
  const firstChangedChunk = line.chunks[chunkIndex] as PosttextLineChunk;
  const unchangedChunks = line.chunks.slice(0, chunkIndex);
  const rebuildText = `${line.text.slice(firstChangedChunk.startOffset, localFrom)}${text}${line.text.slice(
    localTo,
  )}`;

  return [
    ...unchangedChunks,
    ...createLineChunks(
      rebuildText,
      metrics,
      firstChangedChunk.startOffset,
      firstChangedChunk.startColumn,
      firstChangedChunk.x,
    ),
  ];
};

const canShiftChunk = (
  chunk: PosttextLineChunk,
  startColumn: number,
  metrics: PosttextLayoutMetrics,
): boolean => {
  if (!chunk.hasTabs) return true;
  return startColumn % metrics.tabSize === chunk.startColumn % metrics.tabSize;
};

const shiftChunk = (
  chunk: PosttextLineChunk,
  startOffset: number,
  startColumn: number,
  x: number,
): PosttextLineChunk => {
  const columnDelta = startColumn - chunk.startColumn;

  return {
    ...chunk,
    startOffset,
    x,
    startColumn,
    endColumn: chunk.endColumn + columnDelta,
  };
};

const rescanChunk = (
  line: PosttextLineLayout,
  chunk: PosttextLineChunk,
  startOffset: number,
  startColumn: number,
  x: number,
  metrics: PosttextLayoutMetrics,
): PosttextLineChunk =>
  createLineChunk(line.text, chunk.startOffset, startOffset, startColumn, x, metrics);

const repairFollowingChunks = (
  line: PosttextLineLayout,
  firstChunkIndex: number,
  editedChunks: readonly PosttextLineChunk[],
  oldLength: number,
  newLength: number,
  metrics: PosttextLayoutMetrics,
): readonly PosttextLineChunk[] => {
  const repaired: PosttextLineChunk[] = [];
  const lastEditedChunk = editedChunks[editedChunks.length - 1] as PosttextLineChunk;
  let startOffset = lastEditedChunk.startOffset + lastEditedChunk.length;
  let startColumn = lastEditedChunk.endColumn;
  let x = lastEditedChunk.x + lastEditedChunk.width;
  const offsetDelta = newLength - oldLength;

  for (let index = firstChunkIndex; index < line.chunks.length; index += 1) {
    const chunk = line.chunks[index] as PosttextLineChunk;
    if (canReuseChunk(chunk, startOffset, startColumn, x)) {
      repaired.push(...line.chunks.slice(index));
      return repaired;
    }

    const nextChunk = canShiftChunk(chunk, startColumn, metrics)
      ? shiftChunk(chunk, chunk.startOffset + offsetDelta, startColumn, x)
      : rescanChunk(line, chunk, chunk.startOffset + offsetDelta, startColumn, x, metrics);
    repaired.push(nextChunk);
    startOffset = nextChunk.startOffset + nextChunk.length;
    startColumn = nextChunk.endColumn;
    x = nextChunk.x + nextChunk.width;
  }

  return repaired;
};

const canReuseChunk = (
  chunk: PosttextLineChunk,
  startOffset: number,
  startColumn: number,
  x: number,
): boolean => {
  if (chunk.startOffset !== startOffset) return false;
  if (chunk.startColumn !== startColumn) return false;
  return chunk.x === x;
};

const createEditedSameLine = (
  layout: PosttextLayout,
  located: LocatedLine,
  edit: PosttextTextEdit,
): PosttextLineLayout => {
  const localFrom = Math.max(0, edit.from - located.startOffset);
  const localTo = Math.max(localFrom, edit.to - located.startOffset);
  const text = `${located.line.text.slice(0, localFrom)}${edit.text}${located.line.text.slice(
    localTo,
  )}`;
  const chunks = editedLineChunks(located.line, localFrom, localTo, edit.text, layout.metrics);
  const lastChunk = chunks[chunks.length - 1] as PosttextLineChunk;

  return {
    text,
    length: text.length,
    breakLength: located.line.breakLength,
    chunks,
    width: lastChunk.x + lastChunk.width,
  };
};

const replacementLinesForSingleLineEdit = (
  layout: PosttextLayout,
  start: LocatedLine,
  end: LocatedLine,
  edit: PosttextTextEdit,
): PosttextLineLayout[] => {
  if (start.row !== end.row) return replacementLinesForEdit(layout, start, end, edit);
  if (edit.text.includes("\n")) return replacementLinesForEdit(layout, start, end, edit);
  return [createEditedSameLine(layout, start, edit)];
};

const applySingleLayoutEdit = (layout: PosttextLayout, edit: PosttextTextEdit): PosttextLayout => {
  const start = locateLineByOffset(layout, edit.from);
  const end = locateLineByOffset(layout, edit.to);
  const startRun = layout.lineIndex.runs[start.runIndex] as PosttextLineRun;
  const endRun = layout.lineIndex.runs[end.runIndex] as PosttextLineRun;
  const replacementLines = replacementLinesForSingleLineEdit(layout, start, end, edit);
  const replacementRuns = createRunsFromLines(replacementLines, start.row, start.startOffset);
  const removedLineCount = end.row - start.row + 1;
  const rowDelta = replacementLines.length - removedLineCount;
  const offsetDelta = edit.text.length - (edit.to - edit.from);
  const replacementTextLength = linesTextLength(replacementLines, 0, replacementLines.length);
  const runs: PosttextLineRun[] = [];

  runs.push(...layout.lineIndex.runs.slice(0, start.runIndex));
  pushRun(runs, sliceRun(startRun, 0, start.lineIndex, startRun.startRow, startRun.startOffset));
  runs.push(...replacementRuns);

  const suffixLineIndex = end.lineIndex + 1;
  const suffixLineCount = endRun.lineCount - suffixLineIndex;
  const suffixStartRow = start.row + replacementLines.length;
  const suffixStartOffset = start.startOffset + replacementTextLength;
  pushRun(
    runs,
    sliceRun(endRun, suffixLineIndex, suffixLineCount, suffixStartRow, suffixStartOffset),
  );
  runs.push(...adjustedRuns(layout.lineIndex.runs.slice(end.runIndex + 1), rowDelta, offsetDelta));

  return layoutFromRuns(layout.snapshot, layout.metrics, runs);
};

const rangeBoxForLine = (
  layout: PosttextLayout,
  located: LocatedLine,
  startOffset: number,
  endOffset: number,
): PosttextRangeBox | null => {
  const lineStart = Math.max(startOffset, located.startOffset);
  const lineEnd = Math.min(endOffset, lineEndOffset(located));
  if (lineEnd <= lineStart) return null;

  return {
    row: located.row,
    startOffset: lineStart,
    endOffset: lineEnd,
    rect: rectForLineRange(layout, located, lineStart, lineEnd),
  };
};

export const createNoWrapPosttextLayout = (
  snapshot: PieceTableSnapshot,
  metrics: PosttextLayoutMetrics,
): PosttextLayout => {
  const normalizedMetrics = normalizeMetrics(metrics);
  const lines = buildLines(snapshot, normalizedMetrics);
  const runs = createRunsFromLines(lines, 0, 0);
  return layoutFromRuns(snapshot, normalizedMetrics, runs);
};

export const profileNoWrapPosttextLayoutBuild = (
  snapshot: PieceTableSnapshot,
  metrics: PosttextLayoutMetrics,
): NoWrapPosttextLayoutBuildProfile => {
  const normalizedMetrics = normalizeMetrics(metrics);
  const start = nowMs();
  const lines = buildLines(snapshot, normalizedMetrics);
  const linesDone = nowMs();
  const runs = createRunsFromLines(lines, 0, 0);
  const runsDone = nowMs();

  return {
    layout: layoutFromRuns(snapshot, normalizedMetrics, runs),
    buildLinesMs: linesDone - start,
    createRunsMs: runsDone - linesDone,
    totalMs: runsDone - start,
  };
};

export const applyNoWrapPosttextLayoutEdits = (
  layout: PosttextLayout,
  snapshot: PieceTableSnapshot,
  edits: readonly PosttextTextEdit[],
): PosttextLayout => {
  const normalizedMetrics = normalizeMetrics(layout.metrics);
  if (edits.length === 0 && snapshot === layout.snapshot) return layout;
  if (edits.length === 0) return createNoWrapPosttextLayout(snapshot, normalizedMetrics);

  validateLayoutEdits(layout, edits);

  let next = layoutFromRuns(layout.snapshot, normalizedMetrics, layout.lineIndex.runs);
  const sorted = edits.toSorted(compareEditsDescending);

  for (const edit of sorted) {
    next = applySingleLayoutEdit(next, edit);
  }

  return { ...next, snapshot };
};

export const posttextOffsetToXY = (layout: PosttextLayout, offset: number): PosttextXY => {
  const located = locateLineByOffset(layout, offset);

  return {
    x: xForOffsetInLine(located, offset),
    y: lineY(layout, located.row),
  };
};

export const posttextXYToOffset = (layout: PosttextLayout, point: PosttextXY): number => {
  const row = Math.floor(point.y / layout.metrics.lineHeight);
  const located = locateLineByRow(layout, row);
  return offsetForXInLine(located, point.x);
};

export const queryNoWrapPosttextViewport = (
  layout: PosttextLayout,
  viewport: PosttextViewport,
): PosttextViewportResult => {
  const lines: PosttextViewportLine[] = [];
  const startRow = Math.max(0, Math.floor(viewport.y1 / layout.metrics.lineHeight));
  const endRow = Math.min(
    layout.lineIndex.lineCount - 1,
    Math.ceil(viewport.y2 / layout.metrics.lineHeight) - 1,
  );

  for (let row = startRow; row <= endRow; row += 1) {
    const located = locateLineByRow(layout, row);
    const viewportLine = viewportLineForLine(layout, located, viewport);
    if (!viewportLine) continue;
    lines.push(viewportLine);
  }

  return { viewport, lines };
};

export const getPosttextRangeBoxes = (
  layout: PosttextLayout,
  startOffset: number,
  endOffset: number,
): PosttextRangeBox[] => {
  const [start, end] = normalizeRange(layout, startOffset, endOffset);
  if (start === end) return [];

  const boxes: PosttextRangeBox[] = [];
  const startLine = locateLineByOffset(layout, start);
  const endLine = locateLineByOffset(layout, Math.max(start, end - 1));

  for (let row = startLine.row; row <= endLine.row; row += 1) {
    const located = locateLineByRow(layout, row);
    const box = rangeBoxForLine(layout, located, start, end);
    if (!box) continue;
    boxes.push(box);
  }

  return boxes;
};
