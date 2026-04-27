declare const pieceBufferIdBrand: unique symbol;

export type PieceBufferId = string & {
  readonly [pieceBufferIdBrand]: true;
};

export type Point = {
  row: number;
  column: number;
};

export type Piece = {
  buffer: PieceBufferId;
  start: number;
  length: number;
  lineBreaks: number;
};

export type PieceTableBuffers = {
  original: PieceBufferId;
  chunks: ReadonlyMap<PieceBufferId, string>;
};

export type PieceTreeNode = {
  piece: Piece;
  left: PieceTreeNode | null;
  right: PieceTreeNode | null;
  priority: number;
  subtreeLength: number;
  subtreePieces: number;
  subtreeLineBreaks: number;
};

export type PieceTableTreeSnapshot = {
  buffers: PieceTableBuffers;
  root: PieceTreeNode | null;
  length: number;
  pieceCount: number;
};

export type PieceTableSnapshot = PieceTableTreeSnapshot;
