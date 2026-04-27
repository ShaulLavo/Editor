import type {
  Piece,
  PieceBufferId,
  PieceTableTreeSnapshot,
  PieceTreeNode,
  PieceTableBuffers,
  Point,
} from "./pieceTableTypes";

const BUFFER_CHUNK_SIZE = 16 * 1024;
let nextBufferSequence = 0;

const randomPriority = () => Math.random();

const createBufferId = (): PieceBufferId => `buffer:${nextBufferSequence++}` as PieceBufferId;

const getSubtreeLength = (node: PieceTreeNode | null): number => (node ? node.subtreeLength : 0);

const getSubtreePieces = (node: PieceTreeNode | null): number => (node ? node.subtreePieces : 0);

const getSubtreeLineBreaks = (node: PieceTreeNode | null): number =>
  node ? node.subtreeLineBreaks : 0;

const countLineBreaks = (text: string, start = 0, end = text.length): number => {
  let count = 0;
  let index = text.indexOf("\n", start);

  while (index !== -1 && index < end) {
    count++;
    index = text.indexOf("\n", index + 1);
  }

  return count;
};

const getBufferText = (buffers: PieceTableBuffers, buffer: PieceBufferId): string => {
  const text = buffers.chunks.get(buffer);
  if (text !== undefined) return text;
  throw new Error("piece buffer not found");
};

const createPiece = (
  buffers: PieceTableBuffers,
  buffer: PieceBufferId,
  start: number,
  length: number,
): Piece => {
  const text = getBufferText(buffers, buffer);
  return {
    buffer,
    start,
    length,
    lineBreaks: countLineBreaks(text, start, start + length),
  };
};

const cloneNode = (node: PieceTreeNode): PieceTreeNode => ({
  piece: node.piece,
  left: node.left,
  right: node.right,
  priority: node.priority,
  subtreeLength: node.subtreeLength,
  subtreePieces: node.subtreePieces,
  subtreeLineBreaks: node.subtreeLineBreaks,
});

const computeSubtreeLength = (
  piece: Piece,
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
): number => piece.length + getSubtreeLength(left) + getSubtreeLength(right);

const computeSubtreePieces = (left: PieceTreeNode | null, right: PieceTreeNode | null): number =>
  1 + getSubtreePieces(left) + getSubtreePieces(right);

const computeSubtreeLineBreaks = (
  piece: Piece,
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
): number => piece.lineBreaks + getSubtreeLineBreaks(left) + getSubtreeLineBreaks(right);

const createNode = (
  piece: Piece,
  left: PieceTreeNode | null = null,
  right: PieceTreeNode | null = null,
  priority = randomPriority(),
): PieceTreeNode => ({
  piece,
  left,
  right,
  priority,
  subtreeLength: computeSubtreeLength(piece, left, right),
  subtreePieces: computeSubtreePieces(left, right),
  subtreeLineBreaks: computeSubtreeLineBreaks(piece, left, right),
});

const updateNode = (node: PieceTreeNode | null): PieceTreeNode | null => {
  if (!node) return node;
  node.subtreeLength = computeSubtreeLength(node.piece, node.left, node.right);
  node.subtreePieces = computeSubtreePieces(node.left, node.right);
  node.subtreeLineBreaks = computeSubtreeLineBreaks(node.piece, node.left, node.right);
  return node;
};

const merge = (left: PieceTreeNode | null, right: PieceTreeNode | null): PieceTreeNode | null => {
  if (!left) return right;
  if (!right) return left;

  if (left.priority < right.priority) {
    const newLeft = cloneNode(left);
    newLeft.right = merge(newLeft.right, right);
    return updateNode(newLeft);
  }

  const newRight = cloneNode(right);
  newRight.left = merge(left, newRight.left);
  return updateNode(newRight);
};

const splitByOffset = (
  node: PieceTreeNode | null,
  offset: number,
  buffers: PieceTableBuffers,
): { left: PieceTreeNode | null; right: PieceTreeNode | null } => {
  if (!node) return { left: null, right: null };

  const leftLen = getSubtreeLength(node.left);
  const nodeLen = node.piece.length;

  if (offset < leftLen) {
    const newNode = cloneNode(node);
    const { left, right } = splitByOffset(newNode.left, offset, buffers);
    newNode.left = right;
    return { left, right: updateNode(newNode) };
  }

  if (offset > leftLen + nodeLen) {
    const newNode = cloneNode(node);
    const { left, right } = splitByOffset(newNode.right, offset - leftLen - nodeLen, buffers);
    newNode.right = left;
    return { left: updateNode(newNode), right };
  }

  if (offset === leftLen) {
    const newNode = cloneNode(node);
    const leftTree = newNode.left;
    newNode.left = null;
    return { left: leftTree, right: updateNode(newNode) };
  }

  if (offset === leftLen + nodeLen) {
    const newNode = cloneNode(node);
    const rightTree = newNode.right;
    newNode.right = null;
    return { left: updateNode(newNode), right: rightTree };
  }

  // Split within the current piece
  const localOffset = offset - leftLen;
  const leftPieceLength = localOffset;
  const rightPieceLength = nodeLen - localOffset;

  const leftPiece = createPiece(buffers, node.piece.buffer, node.piece.start, leftPieceLength);
  const rightPiece = createPiece(
    buffers,
    node.piece.buffer,
    node.piece.start + localOffset,
    rightPieceLength,
  );

  const leftNode = createNode(leftPiece);
  const rightNode = createNode(rightPiece);

  const leftTree = merge(node.left, leftNode);
  const rightTree = merge(rightNode, node.right);

  return { left: leftTree, right: rightTree };
};

const createTreeFromPieces = (pieces: readonly Piece[]): PieceTreeNode | null => {
  let tree: PieceTreeNode | null = null;

  for (const piece of pieces) {
    tree = merge(tree, createNode(piece));
  }

  return tree;
};

const bufferForPiece = (buffers: PieceTableBuffers, piece: Piece) =>
  getBufferText(buffers, piece.buffer);

const countPiecePrefixLineBreaks = (
  buffers: PieceTableBuffers,
  piece: Piece,
  prefixLength: number,
): number => {
  if (prefixLength <= 0) return 0;
  if (prefixLength >= piece.length) return piece.lineBreaks;

  const text = bufferForPiece(buffers, piece);
  return countLineBreaks(text, piece.start, piece.start + prefixLength);
};

const findOffsetAfterPieceLineBreak = (
  buffers: PieceTableBuffers,
  piece: Piece,
  lineBreakOrdinal: number,
): number => {
  const text = bufferForPiece(buffers, piece);
  let remaining = lineBreakOrdinal;

  for (let index = piece.start; index < piece.start + piece.length; index++) {
    if (text[index] !== "\n") continue;
    remaining--;
    if (remaining === 0) return index - piece.start + 1;
  }

  throw new Error("line break not found in piece");
};

const countLineBreaksBeforeOffset = (
  node: PieceTreeNode | null,
  buffers: PieceTableBuffers,
  offset: number,
): number => {
  if (!node || offset <= 0) return 0;

  const leftLen = getSubtreeLength(node.left);
  const nodeEnd = leftLen + node.piece.length;

  if (offset <= leftLen) {
    return countLineBreaksBeforeOffset(node.left, buffers, offset);
  }

  const leftLineBreaks = getSubtreeLineBreaks(node.left);
  if (offset <= nodeEnd) {
    return leftLineBreaks + countPiecePrefixLineBreaks(buffers, node.piece, offset - leftLen);
  }

  return (
    leftLineBreaks +
    node.piece.lineBreaks +
    countLineBreaksBeforeOffset(node.right, buffers, offset - nodeEnd)
  );
};

const findOffsetAfterLineBreak = (
  node: PieceTreeNode | null,
  buffers: PieceTableBuffers,
  lineBreakOrdinal: number,
  baseOffset = 0,
): number | null => {
  if (!node || lineBreakOrdinal <= 0) return null;

  const leftLineBreaks = getSubtreeLineBreaks(node.left);
  const leftLength = getSubtreeLength(node.left);

  if (lineBreakOrdinal <= leftLineBreaks) {
    return findOffsetAfterLineBreak(node.left, buffers, lineBreakOrdinal, baseOffset);
  }

  const remainingAfterLeft = lineBreakOrdinal - leftLineBreaks;
  if (remainingAfterLeft <= node.piece.lineBreaks) {
    return (
      baseOffset +
      leftLength +
      findOffsetAfterPieceLineBreak(buffers, node.piece, remainingAfterLeft)
    );
  }

  return findOffsetAfterLineBreak(
    node.right,
    buffers,
    remainingAfterLeft - node.piece.lineBreaks,
    baseOffset + leftLength + node.piece.length,
  );
};

const lineStartOffset = (snapshot: PieceTableTreeSnapshot, row: number): number => {
  if (row <= 0) return 0;

  const offset = findOffsetAfterLineBreak(snapshot.root, snapshot.buffers, row);
  return offset ?? snapshot.length;
};

const lineEndOffset = (snapshot: PieceTableTreeSnapshot, row: number): number => {
  const totalRows = getSubtreeLineBreaks(snapshot.root);
  if (row >= totalRows) return snapshot.length;

  const nextLineStart = findOffsetAfterLineBreak(snapshot.root, snapshot.buffers, row + 1);
  return nextLineStart === null ? snapshot.length : nextLineStart - 1;
};

const appendChunksToBuffers = (buffers: PieceTableBuffers, text: string): Piece[] => {
  const chunks = buffers.chunks as Map<PieceBufferId, string>;
  const pieces: Piece[] = [];
  let textOffset = 0;

  while (textOffset < text.length) {
    const chunkText = text.slice(textOffset, textOffset + BUFFER_CHUNK_SIZE);
    const buffer = createBufferId();
    chunks.set(buffer, chunkText);
    pieces.push({
      buffer,
      start: 0,
      length: chunkText.length,
      lineBreaks: countLineBreaks(chunkText),
    });
    textOffset += chunkText.length;
  }

  return pieces;
};

const createInitialBuffers = (original: string): PieceTableBuffers => {
  const originalBuffer = createBufferId();
  const chunks = new Map<PieceBufferId, string>([[originalBuffer, original]]);
  return {
    original: originalBuffer,
    chunks,
  };
};

const createOriginalPiece = (buffers: PieceTableBuffers): Piece | null => {
  const original = getBufferText(buffers, buffers.original);
  if (original.length === 0) return null;

  return {
    buffer: buffers.original,
    start: 0,
    length: original.length,
    lineBreaks: countLineBreaks(original),
  };
};

const collectTextInRange = (
  node: PieceTreeNode | null,
  buffers: PieceTableBuffers,
  start: number,
  end: number,
  acc: string[],
  baseOffset = 0,
) => {
  if (!node || baseOffset >= end) return;
  const leftLen = getSubtreeLength(node.left);
  const nodeStart = baseOffset + leftLen;
  const nodeEnd = nodeStart + node.piece.length;

  if (start < nodeStart) {
    collectTextInRange(node.left, buffers, start, end, acc, baseOffset);
  }

  if (nodeEnd > start && nodeStart < end) {
    const pieceStart = Math.max(0, start - nodeStart);
    const pieceEnd = Math.min(node.piece.length, end - nodeStart);
    if (pieceEnd > pieceStart) {
      const buf = bufferForPiece(buffers, node.piece);
      acc.push(buf.slice(node.piece.start + pieceStart, node.piece.start + pieceEnd));
    }
  }

  if (end > nodeEnd) {
    collectTextInRange(node.right, buffers, start, end, acc, nodeEnd);
  }
};

const flattenPieces = (node: PieceTreeNode | null, acc: Piece[]): Piece[] => {
  if (!node) return acc;
  flattenPieces(node.left, acc);
  acc.push({ ...node.piece });
  flattenPieces(node.right, acc);
  return acc;
};

const createSnapshot = (
  buffers: PieceTableBuffers,
  root: PieceTreeNode | null,
): PieceTableTreeSnapshot => ({
  buffers,
  root,
  length: getSubtreeLength(root),
  pieceCount: getSubtreePieces(root),
});

const ensureValidRange = (snapshot: PieceTableTreeSnapshot, start: number, end: number) => {
  if (start < 0 || end < start || end > snapshot.length) {
    throw new RangeError("invalid range");
  }
};

export const createPieceTableSnapshot = (original: string): PieceTableTreeSnapshot => {
  const buffers = createInitialBuffers(original);
  const originalPiece = createOriginalPiece(buffers);
  const root = originalPiece ? createNode(originalPiece) : null;
  return createSnapshot(buffers, root);
};

export const getPieceTableLength = (snapshot: PieceTableTreeSnapshot): number => snapshot.length;

export const getPieceTableOriginalText = (snapshot: PieceTableTreeSnapshot): string =>
  getBufferText(snapshot.buffers, snapshot.buffers.original);

export const getPieceTableText = (
  snapshot: PieceTableTreeSnapshot,
  start = 0,
  end?: number,
): string => {
  const effectiveEnd = end ?? snapshot.length;
  ensureValidRange(snapshot, start, effectiveEnd);
  if (start === effectiveEnd) return "";

  const chunks: string[] = [];
  collectTextInRange(snapshot.root, snapshot.buffers, start, effectiveEnd, chunks);
  return chunks.join("");
};

export const insertIntoPieceTable = (
  snapshot: PieceTableTreeSnapshot,
  offset: number,
  text: string,
): PieceTableTreeSnapshot => {
  if (text.length === 0) return snapshot;
  if (offset < 0 || offset > snapshot.length) {
    throw new RangeError("invalid offset");
  }

  const pieces = appendChunksToBuffers(snapshot.buffers, text);
  const insertionTree = createTreeFromPieces(pieces);
  const { left, right } = splitByOffset(snapshot.root, offset, snapshot.buffers);
  const merged = merge(merge(left, insertionTree), right);
  return createSnapshot(snapshot.buffers, merged);
};

export const deleteFromPieceTable = (
  snapshot: PieceTableTreeSnapshot,
  offset: number,
  length: number,
): PieceTableTreeSnapshot => {
  if (length <= 0) return snapshot;
  ensureValidRange(snapshot, offset, offset + length);

  const { left, right } = splitByOffset(snapshot.root, offset, snapshot.buffers);
  const { right: tail } = splitByOffset(right, length, snapshot.buffers);
  const merged = merge(left, tail);
  return createSnapshot(snapshot.buffers, merged);
};

export const offsetToPoint = (snapshot: PieceTableTreeSnapshot, offset: number): Point => {
  if (offset < 0 || offset > snapshot.length) {
    throw new RangeError("invalid offset");
  }

  const row = countLineBreaksBeforeOffset(snapshot.root, snapshot.buffers, offset);
  const column = offset - lineStartOffset(snapshot, row);
  return { row, column };
};

export const pointToOffset = (snapshot: PieceTableTreeSnapshot, point: Point): number => {
  const row = Math.max(0, point.row);
  const column = Math.max(0, point.column);
  const start = lineStartOffset(snapshot, row);
  const end = lineEndOffset(snapshot, row);
  return Math.min(start + column, end);
};

export const debugPieceTable = (snapshot: PieceTableTreeSnapshot): Piece[] =>
  flattenPieces(snapshot.root, []);
