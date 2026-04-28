import { describe, expect, it } from "vitest";

import { applyBatchToPieceTable, createPieceTableSnapshot } from "../src";
import {
  inferEditorSyntaxLanguage,
  resolveTreeSitterLanguageAlias,
  TREE_SITTER_LANGUAGE_DESCRIPTORS,
  styleForTreeSitterCapture,
  treeSitterCapturesToEditorTokens,
} from "../src/syntax";
import { createTreeSitterEditPayload } from "../src/syntax/session";

describe("Tree-sitter syntax capture conversion", () => {
  it("infers supported language ids from document ids", () => {
    expect(inferEditorSyntaxLanguage("file.ts")).toBe("typescript");
    expect(inferEditorSyntaxLanguage("component.tsx")).toBe("tsx");
    expect(inferEditorSyntaxLanguage("index.js")).toBe("javascript");
    expect(inferEditorSyntaxLanguage("module.mjs")).toBe("javascript");
    expect(inferEditorSyntaxLanguage("config.cts")).toBe("typescript");
    expect(inferEditorSyntaxLanguage("index.html")).toBe("html");
    expect(inferEditorSyntaxLanguage("style.css")).toBe("css");
    expect(inferEditorSyntaxLanguage("data.json")).toBe("json");
    expect(inferEditorSyntaxLanguage("image.png")).toBeNull();
    expect(inferEditorSyntaxLanguage("Makefile")).toBeNull();
    expect(inferEditorSyntaxLanguage("COMPONENT.TSX")).toBe("tsx");
    expect(inferEditorSyntaxLanguage("file.test.ts")).toBe("typescript");
    expect(inferEditorSyntaxLanguage(undefined)).toBeNull();
  });

  it("maps known capture names to editor token styles", () => {
    expect(styleForTreeSitterCapture("keyword.declaration")).toEqual({
      color: "var(--editor-syntax-keyword-declaration)",
    });
    expect(styleForTreeSitterCapture("string")).toEqual({
      color: "var(--editor-syntax-string)",
    });
    expect(styleForTreeSitterCapture("unknown.scope")).toBeNull();
  });

  it("exposes registry descriptors for supported parser and query assets", () => {
    expect(TREE_SITTER_LANGUAGE_DESCRIPTORS.map((descriptor) => descriptor.id)).toEqual([
      "javascript",
      "typescript",
      "tsx",
      "html",
      "css",
      "json",
    ]);
    for (const descriptor of TREE_SITTER_LANGUAGE_DESCRIPTORS) {
      expect(descriptor.wasmUrl).toContain(".wasm");
      expect(descriptor.highlightQuerySource.length).toBeGreaterThan(0);
    }
    expect(resolveTreeSitterLanguageAlias("js")).toBe("javascript");
    expect(resolveTreeSitterLanguageAlias("css")).toBe("css");
    expect(resolveTreeSitterLanguageAlias("sql")).toBeNull();
  });

  it("converts non-empty captures to editor tokens", () => {
    const tokens = treeSitterCapturesToEditorTokens([
      { startIndex: 0, endIndex: 5, captureName: "keyword.declaration" },
      { startIndex: 6, endIndex: 6, captureName: "string" },
      { startIndex: 7, endIndex: 10, captureName: "not.mapped" },
    ]);

    expect(tokens).toEqual([
      {
        start: 0,
        end: 5,
        style: { color: "var(--editor-syntax-keyword-declaration)" },
      },
    ]);
  });

  it("builds single-edit payloads for incremental reparsing", () => {
    const previousSnapshot = createPieceTableSnapshot("const a = 1;\n");
    const edits = [{ from: 6, to: 7, text: "answer" }];
    const nextSnapshot = applyBatchToPieceTable(previousSnapshot, edits);
    const payload = createTreeSitterEditPayload({
      documentId: "file.ts",
      languageId: "typescript",
      snapshotVersion: 2,
      previousSnapshot,
      nextSnapshot,
      edits,
    });

    expect(payload).toMatchObject({
      documentId: "file.ts",
      snapshotVersion: 2,
      languageId: "typescript",
      inputEdits: [
        {
          startIndex: 6,
          oldEndIndex: 7,
          newEndIndex: 12,
          startPosition: { row: 0, column: 6 },
          oldEndPosition: { row: 0, column: 7 },
          newEndPosition: { row: 0, column: 12 },
        },
      ],
    });
  });

  it("builds incremental payloads for multi-edits", () => {
    const previousSnapshot = createPieceTableSnapshot("ab\ncd");
    const edits = [
      { from: 0, to: 1, text: "x" },
      { from: 3, to: 5, text: "yz" },
    ];
    const nextSnapshot = applyBatchToPieceTable(previousSnapshot, edits);
    const payload = createTreeSitterEditPayload({
      documentId: "file.ts",
      languageId: "typescript",
      snapshotVersion: 2,
      previousSnapshot,
      nextSnapshot,
      edits,
    });

    expect(payload?.inputEdits).toMatchObject([
      {
        startIndex: 3,
        oldEndIndex: 5,
        newEndIndex: 5,
        startPosition: { row: 1, column: 0 },
        oldEndPosition: { row: 1, column: 2 },
        newEndPosition: { row: 1, column: 2 },
      },
      {
        startIndex: 0,
        oldEndIndex: 1,
        newEndIndex: 1,
        startPosition: { row: 0, column: 0 },
        oldEndPosition: { row: 0, column: 1 },
        newEndPosition: { row: 0, column: 1 },
      },
    ]);
  });
});
