// oxlint-disable-next-line typescript-eslint/triple-slash-reference
/// <reference path="../../vite-assets.d.ts" />
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
import type { TreeSitterLanguageId } from "./types";

export type TreeSitterLanguageDescriptor = {
  readonly id: TreeSitterLanguageId;
  readonly wasmUrl: string;
  readonly extensions: readonly string[];
  readonly aliases: readonly string[];
  readonly highlightQuerySource: string;
  readonly foldQuerySource?: string;
  readonly injectionQuerySource?: string;
};

const EMPTY_QUERY = "";

export const TREE_SITTER_LANGUAGE_DESCRIPTORS: readonly TreeSitterLanguageDescriptor[] = [
  {
    id: "javascript",
    wasmUrl: jsGrammarUrl,
    extensions: [".cjs", ".js", ".mjs"],
    aliases: ["javascript", "js", "node"],
    highlightQuerySource: [jsHighlightQuerySource, jsxHighlightQuerySource].join("\n"),
    foldQuerySource: jsFoldQuerySource,
    injectionQuerySource: jsPackageInjectionQuerySource,
  },
  {
    id: "typescript",
    wasmUrl: tsGrammarUrl,
    extensions: [".cts", ".mts", ".ts"],
    aliases: ["typescript", "ts"],
    highlightQuerySource: [tsHighlightQuerySource, jsHighlightQuerySource].join("\n"),
    foldQuerySource: [tsFoldQuerySource, jsFoldQuerySource].join("\n"),
    injectionQuerySource: jsPackageInjectionQuerySource,
  },
  {
    id: "tsx",
    wasmUrl: tsxGrammarUrl,
    extensions: [".jsx", ".tsx"],
    aliases: ["tsx", "jsx", "react"],
    highlightQuerySource: [
      tsHighlightQuerySource,
      jsHighlightQuerySource,
      jsxHighlightQuerySource,
    ].join("\n"),
    foldQuerySource: [tsFoldQuerySource, jsFoldQuerySource].join("\n"),
    injectionQuerySource: jsPackageInjectionQuerySource,
  },
  {
    id: "html",
    wasmUrl: htmlGrammarUrl,
    extensions: [".htm", ".html"],
    aliases: ["html"],
    highlightQuerySource: htmlHighlightQuerySource,
    foldQuerySource: "(element) @fold\n(script_element) @fold\n(style_element) @fold",
    injectionQuerySource: htmlInjectionQuerySource,
  },
  {
    id: "css",
    wasmUrl: cssGrammarUrl,
    extensions: [".css"],
    aliases: ["css"],
    highlightQuerySource: cssHighlightQuerySource,
    foldQuerySource: "(block) @fold\n(rule_set) @fold",
    injectionQuerySource: EMPTY_QUERY,
  },
  {
    id: "json",
    wasmUrl: jsonGrammarUrl,
    extensions: [".json"],
    aliases: ["json"],
    highlightQuerySource: jsonHighlightQuerySource,
    foldQuerySource: "(object) @fold\n(array) @fold",
    injectionQuerySource: EMPTY_QUERY,
  },
];

const descriptorsById = new Map(
  TREE_SITTER_LANGUAGE_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
);

const descriptorsByAlias = new Map<string, TreeSitterLanguageDescriptor>();

for (const descriptor of TREE_SITTER_LANGUAGE_DESCRIPTORS) {
  for (const alias of descriptor.aliases) {
    descriptorsByAlias.set(alias.toLowerCase(), descriptor);
  }
}

export const getTreeSitterLanguageDescriptor = (
  languageId: TreeSitterLanguageId,
): TreeSitterLanguageDescriptor => {
  const descriptor = descriptorsById.get(languageId);
  if (!descriptor) throw new Error(`Unknown Tree-sitter language "${languageId}"`);
  return descriptor;
};

export const resolveTreeSitterLanguageAlias = (
  alias: string | null | undefined,
): TreeSitterLanguageId | null => {
  if (!alias) return null;

  const descriptor = descriptorsByAlias.get(alias.trim().toLowerCase());
  return descriptor?.id ?? null;
};

export const isTreeSitterLanguageId = (
  languageId: string | null | undefined,
): languageId is TreeSitterLanguageId => {
  if (!languageId) return false;
  return descriptorsById.has(languageId as TreeSitterLanguageId);
};

export const inferTreeSitterLanguageFromFilename = (
  documentId: string | null | undefined,
): TreeSitterLanguageId | null => {
  if (!documentId) return null;

  const dotIndex = documentId.lastIndexOf(".");
  if (dotIndex === -1) return null;

  const extension = documentId.slice(dotIndex).toLowerCase();
  for (const descriptor of TREE_SITTER_LANGUAGE_DESCRIPTORS) {
    if (descriptor.extensions.includes(extension)) return descriptor.id;
  }

  return null;
};
