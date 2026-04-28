import { describe, expect, it } from "vitest";

import {
  bufferPointToFoldPoint,
  createFoldMap,
  createPieceTableSnapshot,
  deleteFromPieceTable,
  foldPointToBufferPoint,
  resolveAnchor,
} from "../src";
import type { FoldRange } from "../src/syntax";

describe("FoldMap", () => {
  it("converts syntax folds into anchor-backed ranges", () => {
    const snapshot = createPieceTableSnapshot("function f() {\n  return 1;\n}\n");
    const map = createFoldMap(snapshot, [fold(0, 27, 0, 2, "function_declaration")]);
    const range = map.ranges[0]!;

    expect(resolveAnchor(snapshot, range.start)).toEqual({ offset: 0, liveness: "live" });
    expect(resolveAnchor(snapshot, range.end)).toEqual({ offset: 27, liveness: "live" });
    expect(range.startPoint).toEqual({ row: 0, column: 0 });
    expect(range.endPoint).toEqual({ row: 2, column: 0 });
  });

  it("round-trips points outside folded interiors", () => {
    const snapshot = createPieceTableSnapshot("a\nb\nc\nd\n");
    const map = createFoldMap(snapshot, [fold(3, 5, 1, 2, "block")]);
    const folded = bufferPointToFoldPoint(map, { row: 3, column: 0 });

    expect(folded).toEqual({ row: 2, column: 0 });
    expect(foldPointToBufferPoint(map, folded)).toEqual({ row: 3, column: 0 });
  });

  it("resolves fold anchors against later snapshots", () => {
    const snapshot = createPieceTableSnapshot("a\nb\nc\n");
    const map = createFoldMap(snapshot, [fold(3, 5, 1, 2, "block")]);
    const edited = deleteFromPieceTable(snapshot, 2, 2);
    const range = map.ranges[0]!;

    expect(resolveAnchor(edited, range.start).liveness).toBe("deleted");
    expect(resolveAnchor(edited, range.end).offset).toBeGreaterThanOrEqual(2);
  });
});

function fold(
  startIndex: number,
  endIndex: number,
  startLine: number,
  endLine: number,
  type: string,
): FoldRange {
  return { startIndex, endIndex, startLine, endLine, type, languageId: "typescript" };
}
