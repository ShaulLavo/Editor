import {
  anchorAfter,
  anchorBefore,
  offsetToPoint,
  pointToOffset,
  resolveAnchor,
  type PieceTableAnchor,
  type PieceTableSnapshot,
  type Point,
} from "./pieceTable";
import type { FoldRange } from "./syntax/treeSitter/types";

declare const foldPointBrand: unique symbol;

export type FoldPoint = Point & {
  readonly [foldPointBrand]: true;
};

export type AnchorFoldRange = {
  readonly start: PieceTableAnchor;
  readonly end: PieceTableAnchor;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly startPoint: Point;
  readonly endPoint: Point;
  readonly type: string;
  readonly languageId?: FoldRange["languageId"];
};

export type FoldMap = {
  readonly snapshot: PieceTableSnapshot;
  readonly ranges: readonly AnchorFoldRange[];
};

export const createAnchorFoldRanges = (
  snapshot: PieceTableSnapshot,
  folds: readonly FoldRange[],
): AnchorFoldRange[] => {
  const ranges = folds.map((fold) => anchorFoldRangeFromSyntaxFold(snapshot, fold));
  return normalizeAnchorFoldRanges(snapshot, ranges);
};

export const createFoldMap = (
  snapshot: PieceTableSnapshot,
  folds: readonly FoldRange[],
): FoldMap => ({
  snapshot,
  ranges: createAnchorFoldRanges(snapshot, folds),
});

export const bufferPointToFoldPoint = (map: FoldMap, point: Point): FoldPoint => {
  const normalized = pointWithFoldRowDelta(map, point);
  return asFoldPoint(normalized);
};

export const foldPointToBufferPoint = (map: FoldMap, point: FoldPoint): Point => {
  let rowDelta = 0;

  for (const range of map.ranges) {
    const foldedStartRow = range.startPoint.row - rowDelta;
    if (point.row < foldedStartRow) return { row: point.row + rowDelta, column: point.column };
    if (point.row === foldedStartRow) return range.startPoint;
    rowDelta += hiddenLineCount(range);
  }

  return { row: point.row + rowDelta, column: point.column };
};

const anchorFoldRangeFromSyntaxFold = (
  snapshot: PieceTableSnapshot,
  fold: FoldRange,
): AnchorFoldRange => {
  const startOffset = clampOffset(snapshot, fold.startIndex);
  const endOffset = clampOffset(snapshot, fold.endIndex);

  return {
    start: anchorBefore(snapshot, startOffset),
    end: anchorAfter(snapshot, endOffset),
    startOffset,
    endOffset,
    startPoint: offsetToPoint(snapshot, startOffset),
    endPoint: offsetToPoint(snapshot, endOffset),
    type: fold.type,
    languageId: fold.languageId,
  };
};

const normalizeAnchorFoldRanges = (
  snapshot: PieceTableSnapshot,
  ranges: readonly AnchorFoldRange[],
): AnchorFoldRange[] => {
  const resolved = ranges
    .map((range) => resolveFoldRange(snapshot, range))
    .filter((range) => range.endPoint.row > range.startPoint.row)
    .toSorted(
      (left, right) => left.startOffset - right.startOffset || right.endOffset - left.endOffset,
    );

  const normalized: AnchorFoldRange[] = [];
  for (const range of resolved) {
    if (isNestedInLastRange(normalized, range)) continue;
    normalized.push(range);
  }

  return normalized;
};

const resolveFoldRange = (
  snapshot: PieceTableSnapshot,
  range: AnchorFoldRange,
): AnchorFoldRange => {
  const startOffset = resolveAnchor(snapshot, range.start).offset;
  const endOffset = resolveAnchor(snapshot, range.end).offset;

  return {
    ...range,
    startOffset,
    endOffset,
    startPoint: offsetToPoint(snapshot, startOffset),
    endPoint: offsetToPoint(snapshot, endOffset),
  };
};

const isNestedInLastRange = (
  ranges: readonly AnchorFoldRange[],
  range: AnchorFoldRange,
): boolean => {
  const previous = ranges.at(-1);
  if (!previous) return false;
  return range.startOffset >= previous.startOffset && range.endOffset <= previous.endOffset;
};

const pointWithFoldRowDelta = (map: FoldMap, point: Point): Point => {
  const offset = pointToOffset(map.snapshot, point);
  let rowDelta = 0;

  for (const range of map.ranges) {
    if (offset > range.endOffset) {
      rowDelta += hiddenLineCount(range);
      continue;
    }

    if (offset > range.startOffset) {
      return { row: range.startPoint.row - rowDelta, column: range.startPoint.column };
    }

    break;
  }

  return { row: point.row - rowDelta, column: point.column };
};

const hiddenLineCount = (range: AnchorFoldRange): number =>
  Math.max(0, range.endPoint.row - range.startPoint.row);

const clampOffset = (snapshot: PieceTableSnapshot, offset: number): number =>
  Math.max(0, Math.min(offset, snapshot.length));

const asFoldPoint = (point: Point): FoldPoint => point as FoldPoint;
