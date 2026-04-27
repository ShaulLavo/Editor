export type { Piece, PieceBufferId, PieceTableSnapshot, Point } from "./pieceTableTypes";

export {
  createPieceTableSnapshot,
  deleteFromPieceTable,
  debugPieceTable,
  getPieceTableLength,
  getPieceTableOriginalText,
  getPieceTableText,
  insertIntoPieceTable,
  offsetToPoint,
  pointToOffset,
} from "./pieceTable";
