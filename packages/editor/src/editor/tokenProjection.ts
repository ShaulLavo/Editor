import type { EditorToken, TextEdit } from "../tokens";

type TokenProjectionIndex = {
  readonly maxEnds: readonly number[];
  readonly sortedByStart: boolean;
};

type TokenProjectionMetadata = {
  readonly keepsLiveRanges: boolean;
  readonly sourceTokens: readonly EditorToken[];
};

type TokenProjectionBuilder = {
  readonly maxEnds: number[];
  readonly tokens: EditorToken[];
  maxEnd: number;
  previousStart: number;
  sortedByStart: boolean;
};

const tokenProjectionIndexes = new WeakMap<readonly EditorToken[], TokenProjectionIndex>();
const tokenProjectionMetadata = new WeakMap<readonly EditorToken[], TokenProjectionMetadata>();

export function projectTokensThroughEdit(
  tokens: readonly EditorToken[],
  edit: TextEdit,
  previousText: string,
): readonly EditorToken[] {
  const delta = edit.text.length - (edit.to - edit.from);
  const indexed = projectIndexedTokensThroughEdit(tokens, edit, previousText, delta);
  if (indexed) return indexed;

  return scanProjectTokensThroughEdit(tokens, edit, previousText, delta);
}

export function tokenProjectionLiveRangeStatus(
  sourceTokens: readonly EditorToken[],
  projectedTokens: readonly EditorToken[],
): boolean | null {
  if (sourceTokens === projectedTokens) return true;

  const metadata = tokenProjectionMetadata.get(projectedTokens);
  if (!metadata) return null;
  if (metadata.sourceTokens !== sourceTokens) return false;
  return metadata.keepsLiveRanges;
}

export function copyTokenProjectionMetadata(
  sourceTokens: readonly EditorToken[],
  copiedTokens: readonly EditorToken[],
): void {
  const index = tokenProjectionIndexes.get(sourceTokens);
  if (index) tokenProjectionIndexes.set(copiedTokens, index);

  const metadata = tokenProjectionMetadata.get(sourceTokens);
  if (metadata) tokenProjectionMetadata.set(copiedTokens, metadata);
}

function scanProjectTokensThroughEdit(
  tokens: readonly EditorToken[],
  edit: TextEdit,
  previousText: string,
  delta: number,
): readonly EditorToken[] {
  const builder = createTokenProjectionBuilder();
  let keepsLiveRanges = true;

  for (const token of tokens) {
    const next = projectTokenThroughEdit(token, edit, previousText, delta);
    if (!isRenderableToken(next)) {
      keepsLiveRanges = false;
      continue;
    }

    appendBuiltToken(builder, next);
  }

  return finishTokenProjection(tokens, builder, keepsLiveRanges);
}

function projectIndexedTokensThroughEdit(
  tokens: readonly EditorToken[],
  edit: TextEdit,
  previousText: string,
  delta: number,
): readonly EditorToken[] | null {
  const index = tokenProjectionIndexes.get(tokens);
  if (!index?.sortedByStart) return null;

  const prefixEnd = unchangedPrefixEnd(index, edit);
  const suffixStart = shiftedSuffixStart(tokens, edit);
  if (prefixEnd > suffixStart) return null;

  return projectSortedTokenRanges(tokens, edit, previousText, delta, prefixEnd, suffixStart);
}

function projectSortedTokenRanges(
  tokens: readonly EditorToken[],
  edit: TextEdit,
  previousText: string,
  delta: number,
  prefixEnd: number,
  suffixStart: number,
): readonly EditorToken[] {
  const builder = createTokenProjectionBuilder();
  let keepsLiveRanges = true;

  appendUnchangedTokens(builder, tokens, 0, prefixEnd);
  keepsLiveRanges = appendProjectedTokens(
    builder,
    tokens,
    edit,
    previousText,
    delta,
    prefixEnd,
    suffixStart,
  );
  appendShiftedTokens(builder, tokens, suffixStart, tokens.length, delta);

  return finishTokenProjection(tokens, builder, keepsLiveRanges);
}

function appendUnchangedTokens(
  builder: TokenProjectionBuilder,
  tokens: readonly EditorToken[],
  start: number,
  end: number,
): void {
  for (let index = start; index < end; index += 1) {
    appendBuiltToken(builder, tokens[index]!);
  }
}

function appendProjectedTokens(
  builder: TokenProjectionBuilder,
  tokens: readonly EditorToken[],
  edit: TextEdit,
  previousText: string,
  delta: number,
  start: number,
  end: number,
): boolean {
  let keepsLiveRanges = true;
  for (let index = start; index < end; index += 1) {
    const next = projectTokenThroughEdit(tokens[index]!, edit, previousText, delta);
    if (!isRenderableToken(next)) {
      keepsLiveRanges = false;
      continue;
    }

    appendBuiltToken(builder, next);
  }

  return keepsLiveRanges;
}

function appendShiftedTokens(
  builder: TokenProjectionBuilder,
  tokens: readonly EditorToken[],
  start: number,
  end: number,
  delta: number,
): void {
  if (delta === 0) {
    appendUnchangedTokens(builder, tokens, start, end);
    return;
  }

  for (let index = start; index < end; index += 1) {
    appendBuiltToken(builder, shiftToken(tokens[index]!, delta));
  }
}

function finishTokenProjection(
  sourceTokens: readonly EditorToken[],
  builder: TokenProjectionBuilder,
  keepsLiveRanges: boolean,
): readonly EditorToken[] {
  const projectedTokens = builder.tokens;
  tokenProjectionIndexes.set(projectedTokens, {
    maxEnds: builder.maxEnds,
    sortedByStart: builder.sortedByStart,
  });
  tokenProjectionMetadata.set(projectedTokens, { keepsLiveRanges, sourceTokens });
  return projectedTokens;
}

function createTokenProjectionBuilder(): TokenProjectionBuilder {
  return {
    maxEnd: 0,
    maxEnds: [],
    previousStart: -Infinity,
    sortedByStart: true,
    tokens: [],
  };
}

function appendBuiltToken(builder: TokenProjectionBuilder, token: EditorToken): void {
  if (token.start < builder.previousStart) builder.sortedByStart = false;
  builder.maxEnd = Math.max(builder.maxEnd, token.end);
  builder.maxEnds.push(builder.maxEnd);
  builder.previousStart = token.start;
  builder.tokens.push(token);
}

function unchangedPrefixEnd(index: TokenProjectionIndex, edit: TextEdit): number {
  if (edit.from === edit.to) return firstTokenEndingAtOrAfter(index, edit.from);
  return firstTokenEndingAfter(index, edit.from);
}

function shiftedSuffixStart(tokens: readonly EditorToken[], edit: TextEdit): number {
  if (edit.from === edit.to) return firstTokenStartingAfter(tokens, edit.from);
  return firstTokenStartingAtOrAfter(tokens, edit.to);
}

function firstTokenEndingAfter(index: TokenProjectionIndex, offset: number): number {
  let low = 0;
  let high = index.maxEnds.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (index.maxEnds[middle]! > offset) {
      high = middle;
      continue;
    }

    low = middle + 1;
  }

  return low;
}

function firstTokenEndingAtOrAfter(index: TokenProjectionIndex, offset: number): number {
  let low = 0;
  let high = index.maxEnds.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (index.maxEnds[middle]! >= offset) {
      high = middle;
      continue;
    }

    low = middle + 1;
  }

  return low;
}

function firstTokenStartingAtOrAfter(tokens: readonly EditorToken[], offset: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (tokens[middle]!.start >= offset) {
      high = middle;
      continue;
    }

    low = middle + 1;
  }

  return low;
}

function firstTokenStartingAfter(tokens: readonly EditorToken[], offset: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (tokens[middle]!.start > offset) {
      high = middle;
      continue;
    }

    low = middle + 1;
  }

  return low;
}

function projectTokenThroughEdit(
  token: EditorToken,
  edit: TextEdit,
  previousText: string,
  delta: number,
): EditorToken | null {
  if (edit.from === edit.to) return projectTokenThroughInsertion(token, edit, previousText);
  if (token.end <= edit.from) return token;
  if (token.start >= edit.to) return shiftToken(token, delta);
  if (!canResizeTokenAcrossEdit(token, edit)) return null;

  return { ...token, end: token.end + delta };
}

function projectTokenThroughInsertion(
  token: EditorToken,
  edit: TextEdit,
  previousText: string,
): EditorToken {
  if (shouldExpandTokenForInsertion(token, edit, previousText)) {
    return { ...token, end: token.end + edit.text.length };
  }
  if (token.start >= edit.from) return shiftToken(token, edit.text.length);

  return token;
}

function canResizeTokenAcrossEdit(token: EditorToken, edit: TextEdit): boolean {
  if (edit.text.includes("\n")) return false;
  return token.start < edit.from && edit.to < token.end;
}

function shouldExpandTokenForInsertion(
  token: EditorToken,
  edit: TextEdit,
  previousText: string,
): boolean {
  if (edit.text.length === 0) return false;
  if (edit.text.includes("\n")) return false;
  if (token.start < edit.from && edit.from < token.end) return true;
  if (!isWordLikeText(edit.text)) return false;
  if (token.end === edit.from) return isWordBeforeOffset(previousText, edit.from);
  if (token.start === edit.from) {
    return (
      !isWordBeforeOffset(previousText, edit.from) && isWordCodePointAt(previousText, edit.from)
    );
  }

  return false;
}

function shiftToken(token: EditorToken, delta: number): EditorToken {
  return {
    ...token,
    start: token.start + delta,
    end: token.end + delta,
  };
}

function isRenderableToken(token: EditorToken | null): token is EditorToken {
  if (!token) return false;
  return token.end > token.start;
}

function isWordLikeText(text: string): boolean {
  return /^[\p{L}\p{N}_]+$/u.test(text);
}

function isWordBeforeOffset(text: string, offset: number): boolean {
  const previous = previousCodePointStart(text, offset);
  if (previous === null) return false;
  return isWordCodePointAt(text, previous);
}

function isWordCodePointAt(text: string, offset: number): boolean {
  const codePoint = text.codePointAt(offset);
  if (codePoint === undefined) return false;
  return /^[\p{L}\p{N}_]$/u.test(String.fromCodePoint(codePoint));
}

function previousCodePointStart(text: string, offset: number): number | null {
  if (offset <= 0) return null;

  const previous = offset - 1;
  const codeUnit = text.charCodeAt(previous);
  const beforePrevious = previous - 1;
  const isLowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
  if (!isLowSurrogate || beforePrevious < 0) return previous;

  const previousCodeUnit = text.charCodeAt(beforePrevious);
  const isHighSurrogate = previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff;
  return isHighSurrogate ? beforePrevious : previous;
}
