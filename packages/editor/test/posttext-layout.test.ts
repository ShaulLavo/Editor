import { describe, expect, it } from "vitest";

import {
  applyBatchToPieceTable,
  applyNoWrapPosttextLayoutEdits,
  createNoWrapPosttextLayout,
  createPieceTableSnapshot,
  getPosttextRangeBoxes,
  posttextOffsetToXY,
  posttextXYToOffset,
  queryNoWrapPosttextViewport,
  type PosttextLayout,
  type PosttextLayoutMetrics,
} from "../src/index.ts";

const metrics: PosttextLayoutMetrics = {
  charWidth: 10,
  lineHeight: 20,
  tabSize: 4,
  fontKey: "test-monospace-10",
};

const firstRunLine = (layout: PosttextLayout, lineIndex: number) => {
  const run = layout.lineIndex.runs[0];
  if (!run) return undefined;
  return run.lines[run.firstLine + lineIndex];
};

const runLine = (layout: PosttextLayout, runIndex: number, lineIndex: number) => {
  const run = layout.lineIndex.runs[runIndex];
  if (!run) return undefined;
  return run.lines[run.firstLine + lineIndex];
};

describe("Posttext no-wrap layout", () => {
  it("prepares reusable per-line local chunks with offset and x boundaries", () => {
    const layout = createNoWrapPosttextLayout(createPieceTableSnapshot("ab\n\tcd"), metrics);
    const line = firstRunLine(layout, 1);

    expect(line?.chunks).toHaveLength(1);
    expect(line?.chunks[0]?.boundaries).toEqual([
      { offset: 0, x: 0 },
      { offset: 1, x: 40 },
      { offset: 2, x: 50 },
      { offset: 3, x: 60 },
    ]);
  });

  it("queries long lines through chunk-local boundaries", () => {
    const text = `${"a".repeat(1023)}\tb`;
    const layout = createNoWrapPosttextLayout(createPieceTableSnapshot(text), metrics);
    const line = firstRunLine(layout, 0);

    expect(line?.chunks.length).toBeGreaterThan(1);
    expect(posttextOffsetToXY(layout, 1024)).toEqual({ x: 10240, y: 0 });
    expect(posttextXYToOffset(layout, { x: 10234, y: 0 })).toBe(1023);
    expect(
      queryNoWrapPosttextViewport(layout, { x1: 10220, y1: 0, x2: 10410, y2: 20 }).lines,
    ).toEqual([
      {
        row: 0,
        startOffset: 0,
        endOffset: 1025,
        visibleStartOffset: 1022,
        visibleEndOffset: 1025,
        rect: { x: 10220, y: 0, width: 30, height: 20 },
      },
    ]);
  });

  it("converts offsets to XY positions with logical lines and tab stops", () => {
    const layout = createNoWrapPosttextLayout(createPieceTableSnapshot("ab\n\tcd"), metrics);

    expect(posttextOffsetToXY(layout, 0)).toEqual({ x: 0, y: 0 });
    expect(posttextOffsetToXY(layout, 2)).toEqual({ x: 20, y: 0 });
    expect(posttextOffsetToXY(layout, 3)).toEqual({ x: 0, y: 20 });
    expect(posttextOffsetToXY(layout, 4)).toEqual({ x: 40, y: 20 });
    expect(posttextOffsetToXY(layout, 6)).toEqual({ x: 60, y: 20 });
  });

  it("converts XY positions to offsets and clamps outside document bounds", () => {
    const layout = createNoWrapPosttextLayout(createPieceTableSnapshot("ab\n\tcd"), metrics);

    expect(posttextXYToOffset(layout, { x: -10, y: 0 })).toBe(0);
    expect(posttextXYToOffset(layout, { x: 14, y: 0 })).toBe(1);
    expect(posttextXYToOffset(layout, { x: 15, y: 0 })).toBe(2);
    expect(posttextXYToOffset(layout, { x: 10, y: 20 })).toBe(3);
    expect(posttextXYToOffset(layout, { x: 25, y: 20 })).toBe(4);
    expect(posttextXYToOffset(layout, { x: 999, y: 20 })).toBe(6);
    expect(posttextXYToOffset(layout, { x: 0, y: 999 })).toBe(3);
  });

  it("queries no-wrap viewport line fragments in both axes", () => {
    const layout = createNoWrapPosttextLayout(
      createPieceTableSnapshot("abcde\n\txy\nlonger"),
      metrics,
    );

    const result = queryNoWrapPosttextViewport(layout, {
      x1: 15,
      y1: 0,
      x2: 45,
      y2: 40,
    });

    expect(result.lines).toEqual([
      {
        row: 0,
        startOffset: 0,
        endOffset: 5,
        visibleStartOffset: 1,
        visibleEndOffset: 5,
        rect: { x: 10, y: 0, width: 40, height: 20 },
      },
      {
        row: 1,
        startOffset: 6,
        endOffset: 9,
        visibleStartOffset: 6,
        visibleEndOffset: 8,
        rect: { x: 0, y: 20, width: 50, height: 20 },
      },
    ]);
  });

  it("omits rows with no horizontal viewport intersection", () => {
    const layout = createNoWrapPosttextLayout(createPieceTableSnapshot("abc\n\nxyz"), metrics);

    expect(queryNoWrapPosttextViewport(layout, { x1: 40, y1: 0, x2: 80, y2: 60 }).lines).toEqual(
      [],
    );
    expect(queryNoWrapPosttextViewport(layout, { x1: -5, y1: 20, x2: 5, y2: 40 }).lines).toEqual([
      {
        row: 1,
        startOffset: 4,
        endOffset: 4,
        visibleStartOffset: 4,
        visibleEndOffset: 4,
        rect: { x: 0, y: 20, width: 0, height: 20 },
      },
    ]);
  });

  it("returns range boxes per logical line without assigning width to newlines", () => {
    const layout = createNoWrapPosttextLayout(createPieceTableSnapshot("abc\nde\n\tz"), metrics);

    expect(getPosttextRangeBoxes(layout, 1, 8)).toEqual([
      {
        row: 0,
        startOffset: 1,
        endOffset: 3,
        rect: { x: 10, y: 0, width: 20, height: 20 },
      },
      {
        row: 1,
        startOffset: 4,
        endOffset: 6,
        rect: { x: 0, y: 20, width: 20, height: 20 },
      },
      {
        row: 2,
        startOffset: 7,
        endOffset: 8,
        rect: { x: 0, y: 40, width: 40, height: 20 },
      },
    ]);
  });

  it("supports trailing newline rows and empty ranges", () => {
    const layout = createNoWrapPosttextLayout(createPieceTableSnapshot("a\n"), metrics);

    expect(layout.lineIndex.lineCount).toBe(2);
    expect(layout.height).toBe(40);
    expect(posttextOffsetToXY(layout, 2)).toEqual({ x: 0, y: 20 });
    expect(getPosttextRangeBoxes(layout, 1, 1)).toEqual([]);
  });

  it("applies line-local edits without rebuilding unaffected prepared lines", () => {
    const snapshot = createPieceTableSnapshot("aa\nbb\ncc");
    const layout = createNoWrapPosttextLayout(snapshot, metrics);
    const edit = { from: 4, to: 5, text: "B" };
    const nextSnapshot = applyBatchToPieceTable(snapshot, [edit]);
    const next = applyNoWrapPosttextLayoutEdits(layout, nextSnapshot, [edit]);

    expect(runLine(next, 0, 0)).toBe(firstRunLine(layout, 0));
    expect(runLine(next, 2, 0)).toBe(firstRunLine(layout, 2));
    expect(runLine(next, 1, 0)?.text).toBe("bB");
    expect(posttextOffsetToXY(next, 5)).toEqual({ x: 20, y: 20 });
    expect(posttextXYToOffset(next, { x: 15, y: 20 })).toBe(5);
  });

  it("adjusts following line runs without shifting prepared tail boundaries", () => {
    const text = Array.from({ length: 600 }, (_, index) => `line-${index}\t`).join("\n");
    const snapshot = createPieceTableSnapshot(text);
    const layout = createNoWrapPosttextLayout(snapshot, metrics);
    const edit = { from: 1, to: 1, text: "X" };
    const nextSnapshot = applyBatchToPieceTable(snapshot, [edit]);
    const next = applyNoWrapPosttextLayoutEdits(layout, nextSnapshot, [edit]);
    const originalTailRun = layout.lineIndex.runs[1];
    const nextTailRun = next.lineIndex.runs.find(
      (run) => run.startRow === originalTailRun?.startRow,
    );

    expect(originalTailRun).toBeDefined();
    expect(nextTailRun).toBeDefined();
    expect(nextTailRun?.lines).toBe(originalTailRun?.lines);
    expect(nextTailRun?.startRow).toBe(originalTailRun?.startRow);
    expect(nextTailRun?.startOffset).toBe((originalTailRun?.startOffset ?? 0) + 1);
    expect(nextTailRun?.lines[nextTailRun.firstLine]?.chunks[0]?.boundaries[0]).toEqual({
      offset: 0,
      x: 0,
    });
    expect(posttextOffsetToXY(next, nextTailRun?.startOffset ?? 0)).toEqual({
      x: 0,
      y: 256 * metrics.lineHeight,
    });
  });

  it("reuses untouched chunks before a same-line long-line edit", () => {
    const snapshot = createPieceTableSnapshot("a".repeat(5_000));
    const layout = createNoWrapPosttextLayout(snapshot, metrics);
    const line = firstRunLine(layout, 0);
    const edit = { from: 2_500, to: 2_501, text: "b" };
    const nextSnapshot = applyBatchToPieceTable(snapshot, [edit]);
    const next = applyNoWrapPosttextLayoutEdits(layout, nextSnapshot, [edit]);
    const nextLine = firstRunLine(next, 0);

    expect(line?.chunks.length).toBeGreaterThan(2);
    expect(nextLine?.chunks[0]).toBe(line?.chunks[0]);
    expect(nextLine?.chunks[1]).toBe(line?.chunks[1]);
    expect(nextLine?.chunks[2]).not.toBe(line?.chunks[2]);
    expect(nextLine?.chunks[3]).toBe(line?.chunks[3]);
    expect(posttextOffsetToXY(next, 2_501)).toEqual({ x: 25010, y: 0 });
  });

  it("shifts following long-line chunks without rescanning when tab phase is unchanged", () => {
    const snapshot = createPieceTableSnapshot("a".repeat(5_000));
    const layout = createNoWrapPosttextLayout(snapshot, metrics);
    const line = firstRunLine(layout, 0);
    const edit = { from: 2_500, to: 2_501, text: "bb" };
    const nextSnapshot = applyBatchToPieceTable(snapshot, [edit]);
    const next = applyNoWrapPosttextLayoutEdits(layout, nextSnapshot, [edit]);
    const nextLine = firstRunLine(next, 0);
    const originalTailChunk = line?.chunks[3];
    const shiftedTailChunk = nextLine?.chunks.find(
      (chunk) => chunk.startOffset === (originalTailChunk?.startOffset ?? 0) + 1,
    );

    expect(originalTailChunk).toBeDefined();
    expect(shiftedTailChunk).toBeDefined();
    expect(shiftedTailChunk).not.toBe(originalTailChunk);
    expect(shiftedTailChunk?.boundaries).toBe(originalTailChunk?.boundaries);
    expect(posttextOffsetToXY(next, 2_502)).toEqual({ x: 25020, y: 0 });
  });

  it("applies newline edits and keeps query results aligned with a fresh layout", () => {
    const snapshot = createPieceTableSnapshot("ab\n\tcd\nxy");
    const layout = createNoWrapPosttextLayout(snapshot, metrics);
    const edit = { from: 2, to: 3, text: "" };
    const nextSnapshot = applyBatchToPieceTable(snapshot, [edit]);
    const next = applyNoWrapPosttextLayoutEdits(layout, nextSnapshot, [edit]);
    const rebuilt = createNoWrapPosttextLayout(nextSnapshot, metrics);

    expect(next.lineIndex.lineCount).toBe(rebuilt.lineIndex.lineCount);
    expect(next.width).toBe(rebuilt.width);
    expect(next.height).toBe(rebuilt.height);
    expect(posttextOffsetToXY(next, 3)).toEqual({ x: 40, y: 0 });
    expect(posttextXYToOffset(next, { x: 30, y: 0 })).toBe(3);
    expect(queryNoWrapPosttextViewport(next, { x1: 0, y1: 0, x2: 45, y2: 20 }).lines).toEqual([
      {
        row: 0,
        startOffset: 0,
        endOffset: 5,
        visibleStartOffset: 0,
        visibleEndOffset: 4,
        rect: { x: 0, y: 0, width: 50, height: 20 },
      },
    ]);
  });
});
