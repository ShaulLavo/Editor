import type { PieceTableSnapshot } from "./pieceTable/pieceTableTypes";
import { forEachPieceTableTextChunk, getPieceTableText } from "./pieceTable/reads";

export type TextSnapshot = {
  readonly length: number;
  getText(): string;
  getTextInRange(start: number, end?: number): string;
  forEachTextChunk(visit: (text: string, start: number, end: number) => void): void;
};

export type DocumentTextSnapshot = TextSnapshot & {
  readonly snapshot: PieceTableSnapshot;
};

export function createDocumentTextSnapshot(
  snapshot: PieceTableSnapshot,
  materializedText?: string,
): DocumentTextSnapshot {
  let cachedText = materializedText?.length === snapshot.length ? materializedText : undefined;

  return {
    snapshot,
    length: snapshot.length,
    getText: () => {
      cachedText ??= getPieceTableText(snapshot);
      return cachedText;
    },
    getTextInRange: (start, end) => {
      const effectiveEnd = end ?? snapshot.length;
      if (cachedText !== undefined && start === 0 && effectiveEnd === snapshot.length) {
        return cachedText;
      }

      return getPieceTableText(snapshot, start, effectiveEnd);
    },
    forEachTextChunk: (visit) => {
      if (cachedText !== undefined) {
        if (cachedText.length > 0) visit(cachedText, 0, cachedText.length);
        return;
      }

      forEachPieceTableTextChunk(snapshot, visit);
    },
  };
}

export function createStringTextSnapshot(text: string): TextSnapshot {
  return {
    length: text.length,
    getText: () => text,
    getTextInRange: (start, end) => text.slice(start, end),
    forEachTextChunk: (visit) => {
      if (text.length > 0) visit(text, 0, text.length);
    },
  };
}

export function defineLazyTextProperty<T extends { readonly textSnapshot: TextSnapshot }>(
  target: T,
): T & { readonly text: string } {
  Object.defineProperty(target, "text", {
    configurable: true,
    enumerable: true,
    get: () => target.textSnapshot.getText(),
  });
  return target as T & { readonly text: string };
}
