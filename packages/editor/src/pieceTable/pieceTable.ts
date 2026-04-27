import type {
  Anchor as AnchorType,
  AnchorBias,
  Piece,
  PieceBufferId,
  PieceTableReverseIndexNode,
  PieceTableTreeSnapshot,
  PieceTreeNode,
  PieceTableBuffers,
  Point,
  RealAnchor,
  ResolvedAnchor,
} from "./pieceTableTypes";

export type { AnchorBias, RealAnchor, ResolvedAnchor };

export const Anchor = {
  MIN: { kind: "min" },
  MAX: { kind: "max" },
} as const satisfies Record<"MIN" | "MAX", AnchorType>;

export type PieceTableEdit = {
  from: number;
  to: number;
  text: string;
};

const BUFFER_CHUNK_SIZE = 16 * 1024;
let nextBufferSequence = 0;
const reverseIndexCache = new WeakMap<PieceTableTreeSnapshot, PieceTableReverseIndexNode | null>();

const randomPriority = () => Math.random();

const createBufferId = (): PieceBufferId => `buffer:${nextBufferSequence++}` as PieceBufferId;

const getSubtreeLength = (node: PieceTreeNode | null): number => (node ? node.subtreeLength : 0);

const getSubtreeVisibleLength = (node: PieceTreeNode | null): number =>
  node ? node.subtreeVisibleLength : 0;

const getSubtreePieces = (node: PieceTreeNode | null): number => (node ? node.subtreePieces : 0);

const getSubtreeLineBreaks = (node: PieceTreeNode | null): number =>
  node ? node.subtreeLineBreaks : 0;

const getPieceVisibleLength = (piece: Piece): number => (piece.visible ? piece.length : 0);

const getPieceVisibleLineBreaks = (piece: Piece): number => (piece.visible ? piece.lineBreaks : 0);

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
  visible = true,
): Piece => {
  const text = getBufferText(buffers, buffer);
  return {
    buffer,
    start,
    length,
    lineBreaks: countLineBreaks(text, start, start + length),
    visible,
  };
};

const cloneNode = (node: PieceTreeNode): PieceTreeNode => ({
  piece: node.piece,
  left: node.left,
  right: node.right,
  priority: node.priority,
  subtreeLength: node.subtreeLength,
  subtreeVisibleLength: node.subtreeVisibleLength,
  subtreePieces: node.subtreePieces,
  subtreeLineBreaks: node.subtreeLineBreaks,
});

const computeSubtreeLength = (
  piece: Piece,
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
): number => piece.length + getSubtreeLength(left) + getSubtreeLength(right);

const computeSubtreeVisibleLength = (
  piece: Piece,
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
): number =>
  getPieceVisibleLength(piece) + getSubtreeVisibleLength(left) + getSubtreeVisibleLength(right);

const computeSubtreePieces = (left: PieceTreeNode | null, right: PieceTreeNode | null): number =>
  1 + getSubtreePieces(left) + getSubtreePieces(right);

const computeSubtreeLineBreaks = (
  piece: Piece,
  left: PieceTreeNode | null,
  right: PieceTreeNode | null,
): number =>
  getPieceVisibleLineBreaks(piece) + getSubtreeLineBreaks(left) + getSubtreeLineBreaks(right);

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
  subtreeVisibleLength: computeSubtreeVisibleLength(piece, left, right),
  subtreePieces: computeSubtreePieces(left, right),
  subtreeLineBreaks: computeSubtreeLineBreaks(piece, left, right),
});

const updateNode = (node: PieceTreeNode | null): PieceTreeNode | null => {
  if (!node) return node;
  node.subtreeLength = computeSubtreeLength(node.piece, node.left, node.right);
  node.subtreeVisibleLength = computeSubtreeVisibleLength(node.piece, node.left, node.right);
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

const splitByVisibleOffset = (
  node: PieceTreeNode | null,
  offset: number,
  buffers: PieceTableBuffers,
): { left: PieceTreeNode | null; right: PieceTreeNode | null } => {
  if (!node) return { left: null, right: null };

  const leftLen = getSubtreeVisibleLength(node.left);
  const nodeLen = getPieceVisibleLength(node.piece);

  if (offset < leftLen) {
    const newNode = cloneNode(node);
    const { left, right } = splitByVisibleOffset(newNode.left, offset, buffers);
    newNode.left = right;
    return { left, right: updateNode(newNode) };
  }

  if (offset > leftLen + nodeLen) {
    const newNode = cloneNode(node);
    const { left, right } = splitByVisibleOffset(
      newNode.right,
      offset - leftLen - nodeLen,
      buffers,
    );
    newNode.right = left;
    return { left: updateNode(newNode), right };
  }

  if (nodeLen === 0) {
    const newNode = cloneNode(node);
    const rightTree = newNode.right;
    newNode.right = null;
    return { left: updateNode(newNode), right: rightTree };
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

  const localOffset = offset - leftLen;
  const leftPiece = createPiece(
    buffers,
    node.piece.buffer,
    node.piece.start,
    localOffset,
    node.piece.visible,
  );
  const rightPiece = createPiece(
    buffers,
    node.piece.buffer,
    node.piece.start + localOffset,
    nodeLen - localOffset,
    node.piece.visible,
  );

  const leftTree = merge(node.left, createNode(leftPiece));
  const rightTree = merge(createNode(rightPiece), node.right);

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
  if (!piece.visible || prefixLength <= 0) return 0;
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

  const leftLen = getSubtreeVisibleLength(node.left);
  const nodeLen = getPieceVisibleLength(node.piece);
  const nodeEnd = leftLen + nodeLen;

  if (offset <= leftLen) return countLineBreaksBeforeOffset(node.left, buffers, offset);

  const leftLineBreaks = getSubtreeLineBreaks(node.left);
  if (offset <= nodeEnd) {
    return leftLineBreaks + countPiecePrefixLineBreaks(buffers, node.piece, offset - leftLen);
  }

  return (
    leftLineBreaks +
    getPieceVisibleLineBreaks(node.piece) +
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
  const leftLength = getSubtreeVisibleLength(node.left);

  if (lineBreakOrdinal <= leftLineBreaks) {
    return findOffsetAfterLineBreak(node.left, buffers, lineBreakOrdinal, baseOffset);
  }

  const remainingAfterLeft = lineBreakOrdinal - leftLineBreaks;
  const pieceLineBreaks = getPieceVisibleLineBreaks(node.piece);
  if (remainingAfterLeft <= pieceLineBreaks) {
    return (
      baseOffset +
      leftLength +
      findOffsetAfterPieceLineBreak(buffers, node.piece, remainingAfterLeft)
    );
  }

  return findOffsetAfterLineBreak(
    node.right,
    buffers,
    remainingAfterLeft - pieceLineBreaks,
    baseOffset + leftLength + getPieceVisibleLength(node.piece),
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
      visible: true,
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
    visible: true,
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

  const leftLen = getSubtreeVisibleLength(node.left);
  const nodeLen = getPieceVisibleLength(node.piece);
  const nodeStart = baseOffset + leftLen;
  const nodeEnd = nodeStart + nodeLen;

  if (start < nodeStart) collectTextInRange(node.left, buffers, start, end, acc, baseOffset);

  if (node.piece.visible && nodeEnd > start && nodeStart < end) {
    const pieceStart = Math.max(0, start - nodeStart);
    const pieceEnd = Math.min(node.piece.length, end - nodeStart);
    if (pieceEnd > pieceStart) {
      const buf = bufferForPiece(buffers, node.piece);
      acc.push(buf.slice(node.piece.start + pieceStart, node.piece.start + pieceEnd));
    }
  }

  if (end > nodeEnd) collectTextInRange(node.right, buffers, start, end, acc, nodeEnd);
};

const flattenPieces = (node: PieceTreeNode | null, acc: Piece[]): Piece[] => {
  if (!node) return acc;
  flattenPieces(node.left, acc);
  acc.push({ ...node.piece });
  flattenPieces(node.right, acc);
  return acc;
};

type VisiblePieceLocation = {
  node: PieceTreeNode;
  visibleStart: number;
  visibleEnd: number;
};

const collectVisiblePieceLocations = (
  node: PieceTreeNode | null,
  acc: VisiblePieceLocation[],
  baseOffset = 0,
): number => {
  if (!node) return baseOffset;

  let offset = collectVisiblePieceLocations(node.left, acc, baseOffset);
  const nodeLen = getPieceVisibleLength(node.piece);

  if (nodeLen > 0) {
    acc.push({
      node,
      visibleStart: offset,
      visibleEnd: offset + nodeLen,
    });
  }

  offset += nodeLen;
  return collectVisiblePieceLocations(node.right, acc, offset);
};

const flattenNodes = (node: PieceTreeNode | null, acc: PieceTreeNode[]): PieceTreeNode[] => {
  if (!node) return acc;
  flattenNodes(node.left, acc);
  acc.push(node);
  flattenNodes(node.right, acc);
  return acc;
};

const compareReverseKeys = (
  leftBuffer: PieceBufferId,
  leftStart: number,
  rightBuffer: PieceBufferId,
  rightStart: number,
): number => {
  if (leftBuffer < rightBuffer) return -1;
  if (leftBuffer > rightBuffer) return 1;
  return leftStart - rightStart;
};

const cloneReverseIndexNode = (node: PieceTableReverseIndexNode): PieceTableReverseIndexNode => ({
  buffer: node.buffer,
  start: node.start,
  pieceNode: node.pieceNode,
  priority: node.priority,
  left: node.left,
  right: node.right,
});

const createReverseIndexNode = (pieceNode: PieceTreeNode): PieceTableReverseIndexNode => ({
  buffer: pieceNode.piece.buffer,
  start: pieceNode.piece.start,
  pieceNode,
  priority: randomPriority(),
  left: null,
  right: null,
});

const rotateReverseRight = (node: PieceTableReverseIndexNode): PieceTableReverseIndexNode => {
  const pivot = cloneReverseIndexNode(node.left!);
  const newRight = cloneReverseIndexNode(node);
  newRight.left = pivot.right;
  pivot.right = newRight;
  return pivot;
};

const rotateReverseLeft = (node: PieceTableReverseIndexNode): PieceTableReverseIndexNode => {
  const pivot = cloneReverseIndexNode(node.right!);
  const newLeft = cloneReverseIndexNode(node);
  newLeft.right = pivot.left;
  pivot.left = newLeft;
  return pivot;
};

const insertReverseIndexNode = (
  root: PieceTableReverseIndexNode | null,
  pieceNode: PieceTreeNode,
): PieceTableReverseIndexNode => {
  if (!root) return createReverseIndexNode(pieceNode);

  const comparison = compareReverseKeys(
    pieceNode.piece.buffer,
    pieceNode.piece.start,
    root.buffer,
    root.start,
  );

  if (comparison < 0) {
    const next = cloneReverseIndexNode(root);
    next.left = insertReverseIndexNode(next.left, pieceNode);
    return next.left.priority < next.priority ? rotateReverseRight(next) : next;
  }

  if (comparison > 0) {
    const next = cloneReverseIndexNode(root);
    next.right = insertReverseIndexNode(next.right, pieceNode);
    return next.right.priority < next.priority ? rotateReverseLeft(next) : next;
  }

  return {
    ...root,
    pieceNode,
  };
};

const buildReverseIndex = (root: PieceTreeNode | null): PieceTableReverseIndexNode | null => {
  let indexRoot: PieceTableReverseIndexNode | null = null;
  const nodes = flattenNodes(root, []);

  for (const node of nodes) {
    if (node.piece.length === 0) continue;
    indexRoot = insertReverseIndexNode(indexRoot, node);
  }

  return indexRoot;
};

const getSnapshotReverseIndexRoot = (
  snapshot: PieceTableTreeSnapshot,
): PieceTableReverseIndexNode | null => {
  if (snapshot.reverseIndexRoot) return snapshot.reverseIndexRoot;
  if (reverseIndexCache.has(snapshot)) return reverseIndexCache.get(snapshot) ?? null;

  const root = buildReverseIndex(snapshot.root);
  reverseIndexCache.set(snapshot, root);
  return root;
};

const reversePredecessor = (
  root: PieceTableReverseIndexNode | null,
  buffer: PieceBufferId,
  offset: number,
  strict: boolean,
): PieceTableReverseIndexNode | null => {
  let node = root;
  let candidate: PieceTableReverseIndexNode | null = null;

  while (node) {
    const comparison = compareReverseKeys(node.buffer, node.start, buffer, offset);
    const accepts = strict ? comparison < 0 : comparison <= 0;

    if (accepts) {
      candidate = node;
      node = node.right;
      continue;
    }

    node = node.left;
  }

  if (candidate?.buffer === buffer) return candidate;
  return null;
};

const coversAnchorOffset = (piece: Piece, offset: number): boolean =>
  offset >= piece.start && offset <= piece.start + piece.length;

const lookupReverseIndex = (
  snapshot: PieceTableTreeSnapshot,
  anchor: RealAnchor,
): PieceTableReverseIndexNode | null => {
  const strict = anchor.bias === "left" && anchor.offset > 0;
  const root = getSnapshotReverseIndexRoot(snapshot);
  const preferred = reversePredecessor(root, anchor.buffer, anchor.offset, strict);

  if (preferred && coversAnchorOffset(preferred.pieceNode.piece, anchor.offset)) return preferred;

  const fallback = reversePredecessor(root, anchor.buffer, anchor.offset, false);
  if (fallback && coversAnchorOffset(fallback.pieceNode.piece, anchor.offset)) return fallback;

  return null;
};

const createSnapshot = (
  buffers: PieceTableBuffers,
  root: PieceTreeNode | null,
): PieceTableTreeSnapshot => ({
  buffers,
  root,
  reverseIndexRoot: null,
  length: getSubtreeVisibleLength(root),
  pieceCount: getSubtreePieces(root),
});

const ensureValidRange = (snapshot: PieceTableTreeSnapshot, start: number, end: number) => {
  if (start < 0 || end < start || end > snapshot.length) {
    throw new RangeError("invalid range");
  }
};

const ensureCodePointBoundary = (snapshot: PieceTableTreeSnapshot, offset: number): void => {
  if (offset <= 0 || offset >= snapshot.length) return;

  const text = getPieceTableText(snapshot, offset - 1, offset + 1);
  const before = text.charCodeAt(0);
  const after = text.charCodeAt(1);
  const beforeIsHighSurrogate = before >= 0xd800 && before <= 0xdbff;
  const afterIsLowSurrogate = after >= 0xdc00 && after <= 0xdfff;

  if (beforeIsHighSurrogate && afterIsLowSurrogate) {
    throw new RangeError("anchor offset must be a code-point boundary");
  }
};

const anchorFromLocation = (
  location: VisiblePieceLocation,
  offset: number,
  bias: AnchorBias,
): RealAnchor => {
  const pieceOffset = offset - location.visibleStart;

  return {
    kind: "anchor",
    buffer: location.node.piece.buffer,
    offset: location.node.piece.start + pieceOffset,
    bias,
  };
};

const anchorInEmptySnapshot = (snapshot: PieceTableTreeSnapshot, bias: AnchorBias): RealAnchor => ({
  kind: "anchor",
  buffer: snapshot.buffers.original,
  offset: 0,
  bias,
});

const findAnchorLocation = (
  snapshot: PieceTableTreeSnapshot,
  offset: number,
  bias: AnchorBias,
): VisiblePieceLocation | null => {
  const locations: VisiblePieceLocation[] = [];
  collectVisiblePieceLocations(snapshot.root, locations);

  if (locations.length === 0) return null;

  for (const location of locations) {
    if (offset > location.visibleStart && offset < location.visibleEnd) return location;
  }

  const left = locations.findLast((location) => location.visibleEnd === offset) ?? null;
  const right = locations.find((location) => location.visibleStart === offset) ?? null;

  if (bias === "left") return left ?? right;
  return right ?? left;
};

const markTreeInvisible = (node: PieceTreeNode | null): PieceTreeNode | null => {
  if (!node) return null;

  const next = cloneNode(node);
  next.left = markTreeInvisible(next.left);
  next.right = markTreeInvisible(next.right);
  next.piece = {
    ...next.piece,
    visible: false,
  };

  return updateNode(next);
};

const visiblePrefixBeforeNode = (
  root: PieceTreeNode | null,
  target: PieceTreeNode,
  baseOffset = 0,
): number | null => {
  if (!root) return null;

  const leftLength = getSubtreeVisibleLength(root.left);
  const nodeStart = baseOffset + leftLength;

  if (root === target) return nodeStart;

  const leftResult = visiblePrefixBeforeNode(root.left, target, baseOffset);
  if (leftResult !== null) return leftResult;

  return visiblePrefixBeforeNode(root.right, target, nodeStart + getPieceVisibleLength(root.piece));
};

const deletedRightEdgeOffset = (
  snapshot: PieceTableTreeSnapshot,
  target: PieceTreeNode,
  prefix: number,
): number => {
  const nodes = flattenNodes(snapshot.root, []);
  const targetIndex = nodes.indexOf(target);
  if (targetIndex === -1) return prefix;

  let offset = prefix;
  const deletedEnd = target.piece.start + target.piece.length;

  for (let index = targetIndex + 1; index < nodes.length; index++) {
    const piece = nodes[index].piece;
    if (piece.buffer === target.piece.buffer && piece.start >= deletedEnd) break;
    offset += getPieceVisibleLength(piece);
  }

  return offset;
};

const deletedLeftEdgeOffset = (
  snapshot: PieceTableTreeSnapshot,
  target: PieceTreeNode,
  prefix: number,
): number => {
  const nodes = flattenNodes(snapshot.root, []);
  const targetIndex = nodes.indexOf(target);
  if (targetIndex === -1) return prefix;

  let offset = prefix;

  for (let index = targetIndex - 1; index >= 0; index--) {
    const piece = nodes[index].piece;
    if (piece.buffer === target.piece.buffer && piece.start + piece.length <= target.piece.start) {
      break;
    }
    offset -= getPieceVisibleLength(piece);
  }

  return offset;
};

const resolveAnchorAgainstNode = (
  snapshot: PieceTableTreeSnapshot,
  anchor: RealAnchor,
  pieceNode: PieceTreeNode,
): ResolvedAnchor => {
  const prefix = visiblePrefixBeforeNode(snapshot.root, pieceNode);
  if (prefix === null) return { offset: 0, liveness: "deleted" };

  if (pieceNode.piece.visible) {
    return {
      offset: prefix + Math.min(anchor.offset - pieceNode.piece.start, pieceNode.piece.length),
      liveness: "live",
    };
  }

  return {
    offset:
      anchor.bias === "left"
        ? deletedLeftEdgeOffset(snapshot, pieceNode, prefix)
        : deletedRightEdgeOffset(snapshot, pieceNode, prefix),
    liveness: "deleted",
  };
};

const resolveMissingAnchor = (
  snapshot: PieceTableTreeSnapshot,
  anchor: RealAnchor,
): ResolvedAnchor => {
  if (!snapshot.root && anchor.buffer === snapshot.buffers.original && anchor.offset === 0) {
    return { offset: 0, liveness: "live" };
  }

  return { offset: 0, liveness: "deleted" };
};

const findLinearAnchorNode = (
  snapshot: PieceTableTreeSnapshot,
  anchor: RealAnchor,
): PieceTreeNode | null => {
  const nodes = flattenNodes(snapshot.root, []);
  const candidates = nodes.filter((node) => {
    if (node.piece.buffer !== anchor.buffer) return false;
    return coversAnchorOffset(node.piece, anchor.offset);
  });

  if (candidates.length === 0) return null;

  if (anchor.bias === "left") {
    return candidates.findLast((node) => node.piece.start < anchor.offset) ?? candidates[0];
  }

  return (
    candidates.find((node) => node.piece.start === anchor.offset) ??
    candidates.find((node) => node.piece.start <= anchor.offset) ??
    candidates[0]
  );
};

const compareEditsDescending = (left: PieceTableEdit, right: PieceTableEdit): number => {
  if (left.from !== right.from) return right.from - left.from;
  return right.to - left.to;
};

const validateBatchEdits = (
  snapshot: PieceTableTreeSnapshot,
  edits: readonly PieceTableEdit[],
): void => {
  let previousEnd = -1;
  const sorted = [...edits].sort((left, right) => left.from - right.from);

  for (const edit of sorted) {
    ensureValidRange(snapshot, edit.from, edit.to);
    if (edit.from < previousEnd) throw new RangeError("batch edits must not overlap");
    previousEnd = edit.to;
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
  const { left, right } = splitByVisibleOffset(snapshot.root, offset, snapshot.buffers);
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

  const { left, right } = splitByVisibleOffset(snapshot.root, offset, snapshot.buffers);
  const { left: deleted, right: tail } = splitByVisibleOffset(right, length, snapshot.buffers);
  const merged = merge(merge(left, markTreeInvisible(deleted)), tail);
  return createSnapshot(snapshot.buffers, merged);
};

export const applyBatchToPieceTable = (
  snapshot: PieceTableTreeSnapshot,
  edits: readonly PieceTableEdit[],
): PieceTableTreeSnapshot => {
  if (edits.length === 0) return snapshot;

  validateBatchEdits(snapshot, edits);

  let next = snapshot;
  const sorted = [...edits].sort(compareEditsDescending);

  for (const edit of sorted) {
    next = deleteFromPieceTable(next, edit.from, edit.to - edit.from);
    next = insertIntoPieceTable(next, edit.from, edit.text);
  }

  return next;
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

export const anchorAt = (
  snapshot: PieceTableTreeSnapshot,
  offset: number,
  bias: AnchorBias,
): RealAnchor => {
  if (offset < 0 || offset > snapshot.length) {
    throw new RangeError("invalid offset");
  }

  ensureCodePointBoundary(snapshot, offset);

  const location = findAnchorLocation(snapshot, offset, bias);
  if (!location) return anchorInEmptySnapshot(snapshot, bias);

  return anchorFromLocation(location, offset, bias);
};

export const anchorBefore = (snapshot: PieceTableTreeSnapshot, offset: number): RealAnchor =>
  anchorAt(snapshot, offset, "left");

export const anchorAfter = (snapshot: PieceTableTreeSnapshot, offset: number): RealAnchor =>
  anchorAt(snapshot, offset, "right");

export const resolveAnchorLinear = (
  snapshot: PieceTableTreeSnapshot,
  anchor: AnchorType,
): ResolvedAnchor => {
  if (anchor.kind === "min") return { offset: 0, liveness: "live" };
  if (anchor.kind === "max") return { offset: snapshot.length, liveness: "live" };

  const pieceNode = findLinearAnchorNode(snapshot, anchor);
  if (!pieceNode) return resolveMissingAnchor(snapshot, anchor);

  return resolveAnchorAgainstNode(snapshot, anchor, pieceNode);
};

export const resolveAnchor = (
  snapshot: PieceTableTreeSnapshot,
  anchor: AnchorType,
): ResolvedAnchor => {
  if (anchor.kind === "min") return { offset: 0, liveness: "live" };
  if (anchor.kind === "max") return { offset: snapshot.length, liveness: "live" };

  const indexed = lookupReverseIndex(snapshot, anchor);
  if (!indexed) return resolveAnchorLinear(snapshot, anchor);

  return resolveAnchorAgainstNode(snapshot, anchor, indexed.pieceNode);
};

export const compareAnchors = (
  snapshot: PieceTableTreeSnapshot,
  left: AnchorType,
  right: AnchorType,
): number => {
  const leftResolved = resolveAnchor(snapshot, left);
  const rightResolved = resolveAnchor(snapshot, right);

  if (leftResolved.offset !== rightResolved.offset)
    return leftResolved.offset - rightResolved.offset;
  if (left.kind !== "anchor" || right.kind !== "anchor") return 0;
  if (left.bias === right.bias) return 0;
  return left.bias === "left" ? -1 : 1;
};

export const debugPieceTable = (snapshot: PieceTableTreeSnapshot): Piece[] =>
  flattenPieces(snapshot.root, []);
