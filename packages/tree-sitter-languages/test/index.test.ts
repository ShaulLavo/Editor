import { describe, expect, it, vi } from "vitest";

import type { EditorPluginContext } from "@editor/core";
import {
  TREE_SITTER_LANGUAGE_CONTRIBUTIONS,
  css,
  html,
  javaScript,
  json,
  typeScript,
} from "../src";

describe("Tree-sitter language contributions", () => {
  it("exports the first-party language descriptors", () => {
    expect(TREE_SITTER_LANGUAGE_CONTRIBUTIONS.map((contribution) => contribution.id)).toEqual([
      "javascript",
      "typescript",
      "html",
      "css",
      "json",
    ]);
    expect(
      TREE_SITTER_LANGUAGE_CONTRIBUTIONS.every((contribution) => {
        return "wasmUrl" in contribution && contribution.wasmUrl.includes(".wasm");
      }),
    ).toBe(true);
  });

  it("exports one configurable plugin per language", () => {
    const plugins = [
      javaScript({ jsx: true }),
      typeScript({ replace: true, tsx: true }),
      html(),
      css(),
      json(),
    ];
    const context = pluginContext();

    for (const plugin of plugins) plugin.activate(context);

    expect(plugins.map((plugin) => plugin.name)).toEqual([
      "tree-sitter-javascript",
      "tree-sitter-typescript",
      "tree-sitter-html",
      "tree-sitter-css",
      "tree-sitter-json",
    ]);
    expect(context.registerTreeSitterLanguage).toHaveBeenCalledTimes(5);
    expect(context.registerTreeSitterLanguage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ aliases: expect.arrayContaining(["jsx"]), id: "javascript" }),
      { replace: undefined },
    );
    expect(context.registerTreeSitterLanguage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ aliases: expect.arrayContaining(["tsx"]), id: "typescript" }),
      { replace: true },
    );
  });
});

function pluginContext(): EditorPluginContext {
  return {
    registerHighlighter: vi.fn(() => ({ dispose: vi.fn() })),
    registerTreeSitterLanguage: vi.fn(() => ({ dispose: vi.fn() })),
    registerViewContribution: vi.fn(() => ({ dispose: vi.fn() })),
    registerGutterContribution: vi.fn(() => ({ dispose: vi.fn() })),
  };
}
