import { describe, expect, test } from "vitest";
import {
  createPieceTableSnapshot,
  deleteFromPieceTable,
  getPieceTableText,
  insertIntoPieceTable,
  debugPieceTable,
  offsetToPoint,
  pointToOffset,
} from "./index";

const countLineBreaks = (text: string): number => [...text].filter((char) => char === "\n").length;

const expectSnapshotText = (
  snapshot: ReturnType<typeof createPieceTableSnapshot>,
  text: string,
) => {
  expect(getPieceTableText(snapshot)).toBe(text);
  expect(snapshot.length).toBe(text.length);
  expect(snapshot.root?.subtreeLineBreaks ?? 0).toBe(countLineBreaks(text));
};

describe("piece table", () => {
  test("basic insert/delete round-trip", () => {
    let snapshot = createPieceTableSnapshot("hello");
    expectSnapshotText(snapshot, "hello");

    snapshot = insertIntoPieceTable(snapshot, 5, " world");
    expectSnapshotText(snapshot, "hello world");

    snapshot = deleteFromPieceTable(snapshot, 5, 1);
    expectSnapshotText(snapshot, "helloworld");
  });

  test("keeps previous snapshots readable after later edits", () => {
    const initial = createPieceTableSnapshot("abc");
    const inserted = insertIntoPieceTable(initial, 1, "XX");
    const deleted = deleteFromPieceTable(inserted, 2, 2);

    expectSnapshotText(initial, "abc");
    expectSnapshotText(inserted, "aXXbc");
    expectSnapshotText(deleted, "aXc");
  });

  test("allocates a distinct opaque buffer chunk for each small insertion", () => {
    let snapshot = createPieceTableSnapshot("");

    for (let index = 0; index < 1000; index++) {
      snapshot = insertIntoPieceTable(snapshot, snapshot.length, "x");
    }

    const pieces = debugPieceTable(snapshot);
    const buffers = new Set(pieces.map((piece) => piece.buffer));
    expect(pieces).toHaveLength(1000);
    expect(buffers.size).toBe(1000);
    expectSnapshotText(snapshot, "x".repeat(1000));
  });

  test("splits large inserts across bounded chunks", () => {
    const text = "x".repeat(40_000);
    const snapshot = insertIntoPieceTable(createPieceTableSnapshot(""), 0, text);
    const pieces = debugPieceTable(snapshot);

    expect(pieces.length).toBeGreaterThan(1);
    expectSnapshotText(snapshot, text);
  });

  test("keeps line-break counts correct across inserts, deletes, and splits", () => {
    let snapshot = createPieceTableSnapshot("ab\ncd\nef");
    snapshot = insertIntoPieceTable(snapshot, 4, "X\nY\n");
    snapshot = deleteFromPieceTable(snapshot, 1, 5);

    expectSnapshotText(snapshot, "aY\nd\nef");
    expect(debugPieceTable(snapshot).reduce((sum, piece) => sum + piece.lineBreaks, 0)).toBe(2);
  });

  test("converts offsets to points at line boundaries", () => {
    const snapshot = createPieceTableSnapshot("ab\ncde\n\nf");

    expect(offsetToPoint(snapshot, 0)).toEqual({ row: 0, column: 0 });
    expect(offsetToPoint(snapshot, 2)).toEqual({ row: 0, column: 2 });
    expect(offsetToPoint(snapshot, 3)).toEqual({ row: 1, column: 0 });
    expect(offsetToPoint(snapshot, 6)).toEqual({ row: 1, column: 3 });
    expect(offsetToPoint(snapshot, 7)).toEqual({ row: 2, column: 0 });
    expect(offsetToPoint(snapshot, 8)).toEqual({ row: 3, column: 0 });
    expect(offsetToPoint(snapshot, 9)).toEqual({ row: 3, column: 1 });
  });

  test("converts points to offsets and clamps columns to line ends", () => {
    const snapshot = createPieceTableSnapshot("ab\ncde\n\nf");

    expect(pointToOffset(snapshot, { row: 0, column: 99 })).toBe(2);
    expect(pointToOffset(snapshot, { row: 1, column: 2 })).toBe(5);
    expect(pointToOffset(snapshot, { row: 1, column: 99 })).toBe(6);
    expect(pointToOffset(snapshot, { row: 2, column: 99 })).toBe(7);
    expect(pointToOffset(snapshot, { row: 3, column: 1 })).toBe(9);
    expect(pointToOffset(snapshot, { row: 99, column: 0 })).toBe(9);
    expect(pointToOffset(snapshot, { row: -1, column: -1 })).toBe(0);
  });

  test("round-trips every offset through point conversion", () => {
    let snapshot = createPieceTableSnapshot("ab\ncde\n\nf");
    snapshot = insertIntoPieceTable(snapshot, 3, "XX\n");
    snapshot = deleteFromPieceTable(snapshot, 1, 2);

    for (let offset = 0; offset <= snapshot.length; offset++) {
      expect(pointToOffset(snapshot, offsetToPoint(snapshot, offset))).toBe(offset);
    }
  });
});
