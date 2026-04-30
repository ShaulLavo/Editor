import { describe, expect, it } from "vitest";

import {
  createFoldGutterPlugin,
  createLineGutterPlugin,
  createPieceTableSnapshot,
  Editor,
  getPieceTableText,
  type EditorState,
  type TextEdit,
} from "../src/index.ts";

describe("public API facade", () => {
  it("exports editor and piece-table entrypoints from the package root", () => {
    const snapshot = createPieceTableSnapshot("abc");
    const edit: TextEdit = { from: 1, to: 2, text: "B" };
    const state = { documentId: null } as EditorState;

    expect(Editor).toBeTypeOf("function");
    expect(createLineGutterPlugin).toBeTypeOf("function");
    expect(createFoldGutterPlugin).toBeTypeOf("function");
    expect(getPieceTableText(snapshot)).toBe("abc");
    expect(edit).toEqual({ from: 1, to: 2, text: "B" });
    expect(state.documentId).toBeNull();
  });
});
