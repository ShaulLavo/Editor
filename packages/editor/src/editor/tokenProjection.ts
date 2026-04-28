import type { EditorToken, TextEdit } from "../tokens";

export function projectTokensThroughEdit(
  tokens: readonly EditorToken[],
  edit: TextEdit,
  previousText: string,
): readonly EditorToken[] {
  const delta = edit.text.length - (edit.to - edit.from);
  const projected: EditorToken[] = [];

  for (const token of tokens) {
    const next = projectTokenThroughEdit(token, edit, previousText, delta);
    if (!next || next.end <= next.start) continue;
    projected.push(next);
  }

  return projected;
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
