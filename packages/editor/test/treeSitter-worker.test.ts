import { describe, expect, it } from "vitest";
import type { Node } from "web-tree-sitter";

import { createPieceTableSnapshot, insertIntoPieceTable } from "../src";
import { __treeSitterWorkerInternalsForTests } from "../src/syntax/treeSitter/treeSitter.worker.ts";

const {
  applyTextEdit,
  applyTextEdits,
  collectBracket,
  collectError,
  createTreeSitterPieceTableInput,
  readTreeSitterPieceTableInput,
} = __treeSitterWorkerInternalsForTests;

describe("tree-sitter worker internals", () => {
  it("applies text edits by replacing the old range", () => {
    expect(applyTextEdit("const a = 1;", 6, 7, "answer")).toBe("const answer = 1;");
    expect(applyTextEdit("abcdef", 2, 4, "")).toBe("abef");
    expect(applyTextEdit("abef", 2, 2, "cd")).toBe("abcdef");
  });

  it("applies batch text edits from the original offsets", () => {
    expect(
      applyTextEdits("ab\ncd", [
        { from: 0, to: 1, text: "x" },
        { from: 3, to: 5, text: "yz" },
      ]),
    ).toBe("xb\nyz");
  });

  it("reads parser input from piece-table chunks without flattening", () => {
    const snapshot = insertIntoPieceTable(createPieceTableSnapshot("a😀\n"), 4, "tail");
    const input = createTreeSitterPieceTableInput(snapshot);

    expect(input.chunks.length).toBeGreaterThan(1);
    expect(readTreeSitterPieceTableInput(input, 0)).toBe("a😀\n");
    expect(readTreeSitterPieceTableInput(input, 4)).toBe("tail");
    expect(readTreeSitterPieceTableInput(input, snapshot.length)).toBeUndefined();
  });

  it("tracks bracket depth while walking open and close nodes", () => {
    const stack: { char: string; index: number }[] = [];

    expect(collectBracket(node("(", 0), stack)).toEqual({ index: 0, char: "(", depth: 1 });
    expect(collectBracket(node("{", 1), stack)).toEqual({ index: 1, char: "{", depth: 2 });
    expect(collectBracket(node("}", 2), stack)).toEqual({ index: 2, char: "}", depth: 2 });
    expect(collectBracket(node(")", 3), stack)).toEqual({ index: 3, char: ")", depth: 1 });
    expect(stack).toEqual([]);
  });

  it("reports tree-sitter error and missing nodes", () => {
    expect(collectError(node("ERROR", 4, 9, { isError: true }))).toEqual({
      startIndex: 4,
      endIndex: 9,
      isMissing: false,
      message: "ERROR",
    });

    expect(collectError(node("identifier", 10, 10, { isMissing: true }))).toEqual({
      startIndex: 10,
      endIndex: 10,
      isMissing: true,
      message: "identifier",
    });

    expect(collectError(node("identifier", 0, 10))).toBeNull();
  });
});

function node(
  type: string,
  startIndex: number,
  endIndex = startIndex + 1,
  flags: Partial<Pick<Node, "isError" | "isMissing">> = {},
): Node {
  return {
    type,
    startIndex,
    endIndex,
    isError: flags.isError ?? false,
    isMissing: flags.isMissing ?? false,
  } as Node;
}
