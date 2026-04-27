import { describe, expect, it } from "vitest";

import { deleteFromPieceTable, insertIntoPieceTable } from "../src/pieceTable/edits.ts";
import { createPieceTableSnapshot } from "../src/pieceTable/pieceTable.ts";
import {
  Anchor,
  anchorAfter,
  anchorAt,
  anchorBefore,
  compareAnchors,
  resolveAnchor,
  resolveAnchorLinear,
} from "../src/pieceTable/anchors.ts";

describe("piece table anchors", () => {
  it("resolves sentinel anchors against the current snapshot length", () => {
    const snapshot = createPieceTableSnapshot("abc");

    expect(resolveAnchor(snapshot, Anchor.MIN)).toEqual({ offset: 0, liveness: "live" });
    expect(resolveAnchor(snapshot, Anchor.MAX)).toEqual({ offset: 3, liveness: "live" });
  });

  it("uses bias to order anchors at piece boundaries", () => {
    const snapshot = insertIntoPieceTable(createPieceTableSnapshot("ac"), 1, "b");
    const left = anchorBefore(snapshot, 1);
    const right = anchorAfter(snapshot, 1);

    expect(resolveAnchor(snapshot, left)).toEqual({ offset: 1, liveness: "live" });
    expect(resolveAnchor(snapshot, right)).toEqual({ offset: 1, liveness: "live" });
    expect(compareAnchors(snapshot, left, right)).toBeLessThan(0);
  });

  it("reports deleted liveness and keeps indexed resolution aligned with linear resolution", () => {
    const initial = createPieceTableSnapshot("abcdef");
    const anchors = [anchorAt(initial, 1, "right"), anchorAt(initial, 4, "left")];
    const edited = insertIntoPieceTable(deleteFromPieceTable(initial, 1, 3), 2, "XX");

    for (const anchor of anchors) {
      expect(resolveAnchor(edited, anchor)).toEqual(resolveAnchorLinear(edited, anchor));
    }

    expect(resolveAnchor(edited, anchors[0]!)).toMatchObject({ liveness: "deleted" });
  });
});
