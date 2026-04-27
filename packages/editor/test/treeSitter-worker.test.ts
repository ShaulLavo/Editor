import { describe, expect, it } from "vitest";
import type { Node } from "web-tree-sitter";

import { __treeSitterWorkerInternalsForTests } from "../src/syntax/treeSitter/treeSitter.worker.ts";

const { applyTextEdit, collectBracket, collectError } = __treeSitterWorkerInternalsForTests;

describe("tree-sitter worker internals", () => {
  it("applies text edits by replacing the old range", () => {
    expect(applyTextEdit("const a = 1;", 6, 7, "answer")).toBe("const answer = 1;");
    expect(applyTextEdit("abcdef", 2, 4, "")).toBe("abef");
    expect(applyTextEdit("abef", 2, 2, "cd")).toBe("abcdef");
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
