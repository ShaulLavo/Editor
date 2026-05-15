import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TREE_SITTER_LANGUAGE_CONTRIBUTIONS } from "../../tree-sitter-languages/src/index.ts";

import {
  applyBatchToPieceTable,
  createAnchorSelection,
  createPieceTableSnapshot,
  createSelectionSet,
  resolveSelection,
} from "@editor/core";
import {
  expandTreeSitterSelection,
  resolveTreeSitterLanguageContribution,
  selectTreeSitterToken,
  shrinkTreeSitterSelection,
} from "../src";
import { createTreeSitterEditPayload } from "../src/session.ts";
import {
  disposeTreeSitterWorker,
  editWithTreeSitter,
  parseWithTreeSitter,
  registerTreeSitterLanguagesWithWorker,
} from "../src/treeSitter/workerClient.ts";

describe.skipIf(typeof Worker === "undefined")("tree-sitter worker client", () => {
  beforeEach(async () => {
    await registerDefaultLanguages();
  });

  afterEach(async () => {
    await disposeTreeSitterWorker();
  });

  it("parses and edits through the real browser Worker", async () => {
    const documentId = "file.ts";
    const snapshot = createPieceTableSnapshot("const answer = 1;\n");
    const parsed = await parseWithTreeSitter({
      documentId,
      snapshotVersion: 1,
      languageId: "typescript",
      snapshot,
    });

    expect(parsed?.documentId).toBe(documentId);
    expect(parsed?.snapshotVersion).toBe(1);
    expect(parsed?.captures.length).toBeGreaterThan(0);

    const edits = [{ from: 6, to: 12, text: "value" }];
    const nextSnapshot = applyBatchToPieceTable(snapshot, edits);
    const payload = createTreeSitterEditPayload({
      documentId,
      snapshotVersion: 2,
      languageId: "typescript",
      previousSnapshot: snapshot,
      nextSnapshot,
      edits,
    });
    const edited = payload ? await editWithTreeSitter(payload) : undefined;

    expect(edited?.documentId).toBe(documentId);
    expect(edited?.snapshotVersion).toBe(2);
    expect(edited?.captures.length).toBeGreaterThan(0);
  });

  it("highlights injected script and style content", async () => {
    const documentId = "index.html";
    const text = "<style>.x { color: red; }</style><script>const a = 1;</script>";
    const snapshot = createPieceTableSnapshot(text);
    const parsed = await parseWithTreeSitter({
      documentId,
      snapshotVersion: 1,
      languageId: "html",
      snapshot,
    });

    expect(parsed?.injections.map((injection) => injection.languageId).sort()).toEqual([
      "css",
      "javascript",
    ]);
    expect(parsed?.captures.some((capture) => capture.languageId === "css")).toBe(true);
    expect(parsed?.captures.some((capture) => capture.languageId === "javascript")).toBe(true);
  });

  it("can skip highlight captures while retaining structural results", async () => {
    const documentId = "index.html";
    const text = [
      "<style>",
      ".x {",
      "  color: red;",
      "}",
      "</style>",
      "<script>",
      "const a = 1;",
      "</script>",
    ].join("\n");
    const snapshot = createPieceTableSnapshot(text);
    const parsed = await parseWithTreeSitter({
      documentId,
      snapshotVersion: 1,
      languageId: "html",
      includeHighlights: false,
      snapshot,
    });

    expect(parsed?.captures).toEqual([]);
    expect(parsed?.folds.length).toBeGreaterThan(0);
    expect(parsed?.injections.map((injection) => injection.languageId).sort()).toEqual([
      "css",
      "javascript",
    ]);
  });

  it("parses a consumer-registered language id", async () => {
    const javascript = await resolveTreeSitterLanguageContribution(
      TREE_SITTER_LANGUAGE_CONTRIBUTIONS.find((contribution) => {
        return contribution.id === "javascript";
      })!,
    );
    await registerTreeSitterLanguagesWithWorker([
      {
        ...javascript,
        id: "consumer-javascript",
        extensions: [".consumer-js"],
        aliases: ["consumer-javascript"],
      },
    ]);

    const text = "const answer = 1;\n";
    const snapshot = createPieceTableSnapshot(text);
    const parsed = await parseWithTreeSitter({
      documentId: "file.consumer-js",
      snapshotVersion: 1,
      languageId: "consumer-javascript",
      snapshot,
    });

    expect(parsed?.languageId).toBe("consumer-javascript");
    expect(parsed?.captures.length).toBeGreaterThan(0);
    expect(parsed?.captures.some((capture) => capture.languageId === "consumer-javascript")).toBe(
      true,
    );
  });

  it("highlights injected tagged template content", async () => {
    const documentId = "template.ts";
    const text = [
      "const view = html`<style>.x { color: red; }</style><main>${name}</main>`;",
      'const data = json`{"ok": true}`;',
    ].join("\n");
    const snapshot = createPieceTableSnapshot(text);
    const parsed = await parseWithTreeSitter({
      documentId,
      snapshotVersion: 1,
      languageId: "typescript",
      snapshot,
    });
    const languages = [
      ...new Set(parsed?.injections.map((injection) => injection.languageId)),
    ].sort();

    expect(languages).toEqual(["css", "html", "json"]);
    expect(parsed?.captures.some((capture) => capture.languageId === "html")).toBe(true);
    expect(parsed?.captures.some((capture) => capture.languageId === "css")).toBe(true);
    expect(parsed?.captures.some((capture) => capture.languageId === "json")).toBe(true);
  });

  it("keeps injected layers active after edits outside injected content", async () => {
    const documentId = "index.html";
    const text = "<style>.x { color: red; }</style>";
    const snapshot = createPieceTableSnapshot(text);
    await parseWithTreeSitter({
      documentId,
      snapshotVersion: 1,
      languageId: "html",
      snapshot,
    });

    const edits = [{ from: text.length, to: text.length, text: "\n<main>Hello</main>" }];
    const nextSnapshot = applyBatchToPieceTable(snapshot, edits);
    const payload = createTreeSitterEditPayload({
      documentId,
      snapshotVersion: 2,
      languageId: "html",
      previousSnapshot: snapshot,
      nextSnapshot,
      edits,
    });
    const edited = payload ? await editWithTreeSitter(payload) : undefined;

    expect(edited?.injections.map((injection) => injection.languageId)).toContain("css");
    expect(edited?.captures.some((capture) => capture.languageId === "css")).toBe(true);
  });

  it("updates injected layers after edits inside injected content", async () => {
    const documentId = "index.html";
    const text = "<style>.x { color: red; }</style>";
    const snapshot = createPieceTableSnapshot(text);
    await parseWithTreeSitter({
      documentId,
      snapshotVersion: 1,
      languageId: "html",
      snapshot,
    });

    const cssStart = text.indexOf(".x");
    const cssEnd = text.indexOf("</style>");
    const nextCss = ".x {\n  color: blue;\n}";
    const edits = [{ from: cssStart, to: cssEnd, text: nextCss }];
    const nextSnapshot = applyBatchToPieceTable(snapshot, edits);
    const payload = createTreeSitterEditPayload({
      documentId,
      snapshotVersion: 2,
      languageId: "html",
      previousSnapshot: snapshot,
      nextSnapshot,
      edits,
    });
    const edited = payload ? await editWithTreeSitter(payload) : undefined;
    const colorStart = cssStart + nextCss.indexOf("color");

    expect(edited?.injections.map((injection) => injection.languageId)).toContain("css");
    expect(
      edited?.captures.some((capture) => {
        if (capture.languageId !== "css") return false;
        if (capture.startIndex !== colorStart) return false;
        return capture.endIndex === colorStart + "color".length;
      }),
    ).toBe(true);
  });

  it("groups combined injections into one injected layer", async () => {
    const typescript = await resolveTreeSitterLanguageContribution(
      TREE_SITTER_LANGUAGE_CONTRIBUTIONS.find((contribution) => {
        return contribution.id === "typescript";
      })!,
    );
    await registerTreeSitterLanguagesWithWorker([
      {
        ...typescript,
        id: "combined-typescript",
        extensions: [".combined-ts"],
        aliases: ["combined-typescript"],
        injectionQuerySource: `
          (call_expression
            function: (identifier) @_name
            (#eq? @_name "css")
            arguments: (template_string
              (string_fragment) @injection.content)
            (#set! injection.language "css")
            (#set! injection.combined))
        `,
      },
    ]);

    const text = "const styles = css`.x { color: ${theme.color}; background: red; }`;";
    const snapshot = createPieceTableSnapshot(text);
    const parsed = await parseWithTreeSitter({
      documentId: "style.combined-ts",
      snapshotVersion: 1,
      languageId: "combined-typescript",
      snapshot,
    });

    const cssInjections = parsed?.injections.filter((injection) => injection.languageId === "css");
    expect(cssInjections).toHaveLength(1);
    expect(parsed?.captures.some((capture) => capture.languageId === "css")).toBe(true);
  });

  it("expands and shrinks structural selections through the cached syntax tree", async () => {
    const documentId = "file.ts";
    const snapshot = createPieceTableSnapshot("const answer = 1;\n");
    await parseWithTreeSitter({
      documentId,
      snapshotVersion: 1,
      languageId: "typescript",
      snapshot,
    });

    const selections = createSelectionSet([createAnchorSelection(snapshot, 7)]);
    const token = await selectTreeSitterToken({
      documentId,
      languageId: "typescript",
      snapshotVersion: 1,
      snapshot,
      selections,
    });
    const expanded = await expandTreeSitterSelection({
      documentId,
      languageId: "typescript",
      snapshotVersion: 1,
      snapshot,
      selections: token.selections,
      state: token.state,
    });
    const shrunk = shrinkTreeSitterSelection({
      documentId,
      languageId: "typescript",
      snapshotVersion: 1,
      snapshot,
      selections: expanded.selections,
      state: expanded.state,
    });

    const tokenRange = resolveSelection(snapshot, token.selections.selections[0]!);
    const expandedRange = resolveSelection(snapshot, expanded.selections.selections[0]!);
    const shrunkRange = resolveSelection(snapshot, shrunk.selections.selections[0]!);
    expect(tokenRange).toMatchObject({ startOffset: 6, endOffset: 12 });
    expect(expandedRange.endOffset - expandedRange.startOffset).toBeGreaterThan(6);
    expect(shrunkRange).toMatchObject({ startOffset: 6, endOffset: 12 });
  });

  it("selects tokens inside injected content through the injected layer", async () => {
    const documentId = "index.html";
    const text = "<style>.x { color: red; }</style>";
    const snapshot = createPieceTableSnapshot(text);
    await parseWithTreeSitter({
      documentId,
      snapshotVersion: 1,
      languageId: "html",
      snapshot,
    });

    const offset = text.indexOf("color");
    const selections = createSelectionSet([createAnchorSelection(snapshot, offset)]);
    const token = await selectTreeSitterToken({
      documentId,
      languageId: "html",
      snapshotVersion: 1,
      snapshot,
      selections,
    });

    const tokenRange = resolveSelection(snapshot, token.selections.selections[0]!);
    expect(tokenRange).toMatchObject({ startOffset: offset, endOffset: offset + "color".length });
  });
});

async function registerDefaultLanguages(): Promise<void> {
  const descriptors = await Promise.all(
    TREE_SITTER_LANGUAGE_CONTRIBUTIONS.map(resolveTreeSitterLanguageContribution),
  );
  await registerTreeSitterLanguagesWithWorker(descriptors);
}
