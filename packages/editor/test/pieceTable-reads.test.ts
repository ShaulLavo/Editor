import { describe, expect, it } from "vitest";

import { insertIntoPieceTable } from "../src/pieceTable/edits.ts";
import { createPieceTableSnapshot } from "../src/pieceTable/pieceTable.ts";
import {
  ensureValidRange,
  getPieceTableLength,
  getPieceTableOriginalText,
  getPieceTableText,
} from "../src/pieceTable/reads.ts";

describe("piece table reads", () => {
  it("reads snapshot length, original text, full text, and ranges", () => {
    const initial = createPieceTableSnapshot("abcdef");
    const edited = insertIntoPieceTable(initial, 3, "XX");

    expect(getPieceTableLength(edited)).toBe(8);
    expect(getPieceTableOriginalText(edited)).toBe("abcdef");
    expect(getPieceTableText(edited)).toBe("abcXXdef");
    expect(getPieceTableText(edited, 2, 6)).toBe("cXXd");
    expect(getPieceTableText(edited, 2, 2)).toBe("");
  });

  it("validates read ranges", () => {
    const snapshot = createPieceTableSnapshot("abc");

    expect(() => ensureValidRange(snapshot, 0, 3)).not.toThrow();
    expect(() => ensureValidRange(snapshot, -1, 1)).toThrow(RangeError);
    expect(() => ensureValidRange(snapshot, 2, 1)).toThrow(RangeError);
    expect(() => getPieceTableText(snapshot, 0, 4)).toThrow(RangeError);
  });
});
