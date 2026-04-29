// oxlint-disable-next-line typescript-eslint/triple-slash-reference
/// <reference path="./vite-assets.d.ts" />
import cssHighlightQuerySource from "tree-sitter-css/queries/highlights.scm?raw";
import cssGrammarUrl from "tree-sitter-css/tree-sitter-css.wasm?url";
import htmlHighlightQuerySource from "tree-sitter-html/queries/highlights.scm?raw";
import htmlInjectionQuerySource from "tree-sitter-html/queries/injections.scm?raw";
import htmlGrammarUrl from "tree-sitter-html/tree-sitter-html.wasm?url";
import jsPackageInjectionQuerySource from "tree-sitter-javascript/queries/injections.scm?raw";
import jsxHighlightQuerySource from "tree-sitter-javascript/queries/highlights-jsx.scm?raw";
import jsGrammarUrl from "tree-sitter-javascript/tree-sitter-javascript.wasm?url";
import jsonHighlightQuerySource from "tree-sitter-json/queries/highlights.scm?raw";
import jsonGrammarUrl from "tree-sitter-json/tree-sitter-json.wasm?url";
import tsGrammarUrl from "tree-sitter-typescript/tree-sitter-typescript.wasm?url";
import tsxGrammarUrl from "tree-sitter-typescript/tree-sitter-tsx.wasm?url";
import jsFoldQuerySource from "./queries/javascript-folds.scm?raw";
import jsHighlightQuerySource from "./queries/javascript-highlights.scm?raw";
import tsFoldQuerySource from "./queries/typescript-folds.scm?raw";
import tsHighlightQuerySource from "./queries/typescript-highlights.scm?raw";
import { createTreeSitterLanguagePlugin } from "@editor/core";
import type {
  EditorPlugin,
  TreeSitterLanguageContribution,
  TreeSitterLanguagePluginOptions,
} from "@editor/core";

const EMPTY_QUERY = "";

export type JavaScriptTreeSitterLanguageOptions = TreeSitterLanguagePluginOptions & {
  readonly jsx?: boolean;
};

export type TypeScriptTreeSitterLanguageOptions = TreeSitterLanguagePluginOptions & {
  readonly tsx?: boolean;
};

export const JAVASCRIPT_TREE_SITTER_LANGUAGE = createJavaScriptContribution(false);

export const TYPESCRIPT_TREE_SITTER_LANGUAGE = createTypeScriptContribution(false);

export const HTML_TREE_SITTER_LANGUAGE = {
  id: "html",
  wasmUrl: htmlGrammarUrl,
  extensions: [".htm", ".html"],
  aliases: ["html"],
  highlightQuerySource: htmlHighlightQuerySource,
  foldQuerySource: "(element) @fold\n(script_element) @fold\n(style_element) @fold",
  injectionQuerySource: htmlInjectionQuerySource,
} satisfies TreeSitterLanguageContribution;

export const CSS_TREE_SITTER_LANGUAGE = {
  id: "css",
  wasmUrl: cssGrammarUrl,
  extensions: [".css"],
  aliases: ["css"],
  highlightQuerySource: cssHighlightQuerySource,
  foldQuerySource: "(block) @fold\n(rule_set) @fold",
  injectionQuerySource: EMPTY_QUERY,
} satisfies TreeSitterLanguageContribution;

export const JSON_TREE_SITTER_LANGUAGE = {
  id: "json",
  wasmUrl: jsonGrammarUrl,
  extensions: [".json"],
  aliases: ["json"],
  highlightQuerySource: jsonHighlightQuerySource,
  foldQuerySource: "(object) @fold\n(array) @fold",
  injectionQuerySource: EMPTY_QUERY,
} satisfies TreeSitterLanguageContribution;

export const TREE_SITTER_LANGUAGE_CONTRIBUTIONS = [
  createJavaScriptContribution(true),
  createTypeScriptContribution(true),
  HTML_TREE_SITTER_LANGUAGE,
  CSS_TREE_SITTER_LANGUAGE,
  JSON_TREE_SITTER_LANGUAGE,
] satisfies readonly TreeSitterLanguageContribution[];

export function javaScript(options: JavaScriptTreeSitterLanguageOptions = {}): EditorPlugin {
  const { jsx = false, ...pluginOptions } = options;
  return createLanguagePlugin(
    createJavaScriptContribution(jsx),
    "tree-sitter-javascript",
    pluginOptions,
  );
}

export function typeScript(options: TypeScriptTreeSitterLanguageOptions = {}): EditorPlugin {
  const { tsx = false, ...pluginOptions } = options;
  return createLanguagePlugin(
    createTypeScriptContribution(tsx),
    "tree-sitter-typescript",
    pluginOptions,
  );
}

export function html(options?: TreeSitterLanguagePluginOptions): EditorPlugin {
  return createLanguagePlugin(HTML_TREE_SITTER_LANGUAGE, "tree-sitter-html", options);
}

export function css(options?: TreeSitterLanguagePluginOptions): EditorPlugin {
  return createLanguagePlugin(CSS_TREE_SITTER_LANGUAGE, "tree-sitter-css", options);
}

export function json(options?: TreeSitterLanguagePluginOptions): EditorPlugin {
  return createLanguagePlugin(JSON_TREE_SITTER_LANGUAGE, "tree-sitter-json", options);
}

function createLanguagePlugin(
  contribution: TreeSitterLanguageContribution,
  name: string,
  options: TreeSitterLanguagePluginOptions = {},
): EditorPlugin {
  return createTreeSitterLanguagePlugin([contribution], {
    ...options,
    name: options.name ?? name,
  });
}

function createJavaScriptContribution(jsx: boolean): TreeSitterLanguageContribution {
  return {
    id: "javascript",
    wasmUrl: jsGrammarUrl,
    extensions: jsx ? [".cjs", ".js", ".jsx", ".mjs"] : [".cjs", ".js", ".mjs"],
    aliases: jsx ? ["javascript", "js", "jsx", "node", "react"] : ["javascript", "js", "node"],
    highlightQuerySource: jsx
      ? [jsHighlightQuerySource, jsxHighlightQuerySource].join("\n")
      : jsHighlightQuerySource,
    foldQuerySource: jsFoldQuerySource,
    injectionQuerySource: jsPackageInjectionQuerySource,
  };
}

function createTypeScriptContribution(tsx: boolean): TreeSitterLanguageContribution {
  return {
    id: "typescript",
    wasmUrl: tsx ? tsxGrammarUrl : tsGrammarUrl,
    extensions: tsx ? [".cts", ".mts", ".ts", ".tsx"] : [".cts", ".mts", ".ts"],
    aliases: tsx ? ["typescript", "ts", "tsx", "react"] : ["typescript", "ts"],
    highlightQuerySource: tsx
      ? [tsHighlightQuerySource, jsHighlightQuerySource, jsxHighlightQuerySource].join("\n")
      : [tsHighlightQuerySource, jsHighlightQuerySource].join("\n"),
    foldQuerySource: [tsFoldQuerySource, jsFoldQuerySource].join("\n"),
    injectionQuerySource: jsPackageInjectionQuerySource,
  };
}
