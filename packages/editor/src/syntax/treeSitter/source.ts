import type { PieceTableSnapshot } from "../../pieceTable";
import { forEachPieceTableTextChunk } from "../../pieceTable/reads";

export type TreeSitterSourceChunk = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

export type TreeSitterPieceTableInput = {
  readonly length: number;
  readonly chunks: readonly TreeSitterSourceChunk[];
};

export const createTreeSitterPieceTableInput = (
  snapshot: PieceTableSnapshot,
): TreeSitterPieceTableInput => {
  const chunks: TreeSitterSourceChunk[] = [];
  let offset = 0;

  forEachPieceTableTextChunk(snapshot, (text, start, end) => {
    const chunkText = text.slice(start, end);
    chunks.push({ start: offset, end: offset + chunkText.length, text: chunkText });
    offset += chunkText.length;
  });

  return {
    length: snapshot.length,
    chunks,
  };
};

export const readTreeSitterPieceTableInput = (
  input: TreeSitterPieceTableInput,
  index: number,
): string | undefined => {
  if (index < 0 || index >= input.length) return undefined;

  const chunk = findChunkContaining(input.chunks, index);
  if (!chunk) return undefined;

  return chunk.text.slice(index - chunk.start);
};

export const readTreeSitterInputRange = (
  input: TreeSitterPieceTableInput,
  startIndex: number,
  endIndex: number,
): string => {
  if (endIndex <= startIndex) return "";

  const chunks: string[] = [];
  for (const chunk of input.chunks) {
    if (chunk.end <= startIndex) continue;
    if (chunk.start >= endIndex) break;

    const start = Math.max(startIndex, chunk.start) - chunk.start;
    const end = Math.min(endIndex, chunk.end) - chunk.start;
    chunks.push(chunk.text.slice(start, end));
  }

  return chunks.join("");
};

const findChunkContaining = (
  chunks: readonly TreeSitterSourceChunk[],
  index: number,
): TreeSitterSourceChunk | null => {
  let low = 0;
  let high = chunks.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const chunk = chunks[middle];
    if (!chunk) return null;

    if (index < chunk.start) {
      high = middle - 1;
      continue;
    }

    if (index >= chunk.end) {
      low = middle + 1;
      continue;
    }

    return chunk;
  }

  return null;
};
