import type { EditorToken } from "../tokens";

export type EditorTokenIndex = {
  readonly maxEnds: readonly number[];
  readonly sortedByStart: boolean;
};

export type EditorTokenIndexBuilder = {
  readonly maxEnds: number[];
  maxEnd: number;
  previousStart: number;
  sortedByStart: boolean;
};

const tokenIndexes = new WeakMap<readonly EditorToken[], EditorTokenIndex>();

export function getEditorTokenIndex(tokens: readonly EditorToken[]): EditorTokenIndex | null {
  return tokenIndexes.get(tokens) ?? null;
}

export function copyEditorTokenIndex(
  sourceTokens: readonly EditorToken[],
  copiedTokens: readonly EditorToken[],
): void {
  const index = tokenIndexes.get(sourceTokens);
  if (index) tokenIndexes.set(copiedTokens, index);
}

export function createEditorTokenIndexBuilder(): EditorTokenIndexBuilder {
  return {
    maxEnd: 0,
    maxEnds: [],
    previousStart: -Infinity,
    sortedByStart: true,
  };
}

export function appendEditorTokenIndexEntry(
  builder: EditorTokenIndexBuilder,
  token: EditorToken,
): void {
  if (token.start < builder.previousStart) builder.sortedByStart = false;

  builder.maxEnd = Math.max(builder.maxEnd, token.end);
  builder.maxEnds.push(builder.maxEnd);
  builder.previousStart = token.start;
}

export function setEditorTokenIndex(tokens: readonly EditorToken[], index: EditorTokenIndex): void {
  tokenIndexes.set(tokens, index);
}

export function finishEditorTokenIndex(
  tokens: readonly EditorToken[],
  builder: EditorTokenIndexBuilder,
): void {
  setEditorTokenIndex(tokens, {
    maxEnds: builder.maxEnds,
    sortedByStart: builder.sortedByStart,
  });
}
