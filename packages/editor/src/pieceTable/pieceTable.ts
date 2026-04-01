import type {
	Piece,
	PieceTableTreeSnapshot,
	PieceTreeNode,
	PieceTableBuffers,
} from './pieceTableTypes'

const randomPriority = () => Math.random()

const getSubtreeLength = (node: PieceTreeNode | null): number =>
	node ? node.subtreeLength : 0

const getSubtreePieces = (node: PieceTreeNode | null): number =>
	node ? node.subtreePieces : 0

const cloneNode = (node: PieceTreeNode): PieceTreeNode => ({
	piece: node.piece,
	left: node.left,
	right: node.right,
	priority: node.priority,
	subtreeLength: node.subtreeLength,
	subtreePieces: node.subtreePieces,
})

const createNode = (
	piece: Piece,
	left: PieceTreeNode | null = null,
	right: PieceTreeNode | null = null,
	priority = randomPriority()
): PieceTreeNode => ({
	piece,
	left,
	right,
	priority,
	subtreeLength:
		piece.length + getSubtreeLength(left) + getSubtreeLength(right),
	subtreePieces: 1 + getSubtreePieces(left) + getSubtreePieces(right),
})

const updateNode = (node: PieceTreeNode | null): PieceTreeNode | null => {
	if (!node) return node
	node.subtreeLength =
		node.piece.length +
		getSubtreeLength(node.left) +
		getSubtreeLength(node.right)
	node.subtreePieces =
		1 + getSubtreePieces(node.left) + getSubtreePieces(node.right)
	return node
}

const merge = (
	left: PieceTreeNode | null,
	right: PieceTreeNode | null
): PieceTreeNode | null => {
	if (!left) return right
	if (!right) return left

	if (left.priority < right.priority) {
		const newLeft = cloneNode(left)
		newLeft.right = merge(newLeft.right, right)
		return updateNode(newLeft)
	}

	const newRight = cloneNode(right)
	newRight.left = merge(left, newRight.left)
	return updateNode(newRight)
}

const splitByOffset = (
	node: PieceTreeNode | null,
	offset: number
): { left: PieceTreeNode | null; right: PieceTreeNode | null } => {
	if (!node) return { left: null, right: null }

	const leftLen = getSubtreeLength(node.left)
	const nodeLen = node.piece.length

	if (offset < leftLen) {
		const newNode = cloneNode(node)
		const { left, right } = splitByOffset(newNode.left, offset)
		newNode.left = right
		return { left, right: updateNode(newNode) }
	}

	if (offset > leftLen + nodeLen) {
		const newNode = cloneNode(node)
		const { left, right } = splitByOffset(
			newNode.right,
			offset - leftLen - nodeLen
		)
		newNode.right = left
		return { left: updateNode(newNode), right }
	}

	if (offset === leftLen) {
		const newNode = cloneNode(node)
		const leftTree = newNode.left
		newNode.left = null
		return { left: leftTree, right: updateNode(newNode) }
	}

	if (offset === leftLen + nodeLen) {
		const newNode = cloneNode(node)
		const rightTree = newNode.right
		newNode.right = null
		return { left: updateNode(newNode), right: rightTree }
	}

	// Split within the current piece
	const localOffset = offset - leftLen
	const leftPieceLength = localOffset
	const rightPieceLength = nodeLen - localOffset

	const leftPiece: Piece = {
		buffer: node.piece.buffer,
		start: node.piece.start,
		length: leftPieceLength,
	}

	const rightPiece: Piece = {
		buffer: node.piece.buffer,
		start: node.piece.start + localOffset,
		length: rightPieceLength,
	}

	const leftNode = createNode(leftPiece)
	const rightNode = createNode(rightPiece)

	const leftTree = merge(node.left, leftNode)
	const rightTree = merge(rightNode, node.right)

	return { left: leftTree, right: rightTree }
}

const bufferForPiece = (buffers: PieceTableBuffers, piece: Piece) =>
	piece.buffer === 'original' ? buffers.original : buffers.add

const collectTextInRange = (
	node: PieceTreeNode | null,
	buffers: PieceTableBuffers,
	start: number,
	end: number,
	acc: string[],
	baseOffset = 0
) => {
	if (!node || baseOffset >= end) return
	const leftLen = getSubtreeLength(node.left)
	const nodeStart = baseOffset + leftLen
	const nodeEnd = nodeStart + node.piece.length

	if (start < nodeStart) {
		collectTextInRange(node.left, buffers, start, end, acc, baseOffset)
	}

	if (nodeEnd > start && nodeStart < end) {
		const pieceStart = Math.max(0, start - nodeStart)
		const pieceEnd = Math.min(node.piece.length, end - nodeStart)
		if (pieceEnd > pieceStart) {
			const buf = bufferForPiece(buffers, node.piece)
			acc.push(
				buf.slice(node.piece.start + pieceStart, node.piece.start + pieceEnd)
			)
		}
	}

	if (end > nodeEnd) {
		collectTextInRange(node.right, buffers, start, end, acc, nodeEnd)
	}
}

const flattenPieces = (node: PieceTreeNode | null, acc: Piece[]): Piece[] => {
	if (!node) return acc
	flattenPieces(node.left, acc)
	acc.push({ ...node.piece })
	flattenPieces(node.right, acc)
	return acc
}

const createSnapshot = (
	buffers: PieceTableBuffers,
	root: PieceTreeNode | null
): PieceTableTreeSnapshot => ({
	buffers,
	root,
	length: getSubtreeLength(root),
	pieceCount: getSubtreePieces(root),
})

const appendToAddBuffer = (
	snapshot: PieceTableTreeSnapshot,
	text: string
): {
	buffers: PieceTableTreeSnapshot['buffers']
	piece: Piece
} => {
	const addStart = snapshot.buffers.add.length
	return {
		buffers: {
			original: snapshot.buffers.original,
			add: snapshot.buffers.add + text,
		},
		piece: {
			buffer: 'add',
			start: addStart,
			length: text.length,
		},
	}
}

const ensureValidRange = (
	snapshot: PieceTableTreeSnapshot,
	start: number,
	end: number
) => {
	if (start < 0 || end < start || end > snapshot.length) {
		throw new RangeError('invalid range')
	}
}

export const createPieceTableSnapshot = (
	original: string
): PieceTableTreeSnapshot => {
	const buffers = { original, add: '' }
	const root =
		original.length > 0
			? createNode({
					buffer: 'original',
					start: 0,
					length: original.length,
				})
			: null
	return createSnapshot(buffers, root)
}

export const getPieceTableLength = (snapshot: PieceTableTreeSnapshot): number =>
	snapshot.length

export const getPieceTableOriginalText = (
	snapshot: PieceTableTreeSnapshot
): string => snapshot.buffers.original

export const getPieceTableText = (
	snapshot: PieceTableTreeSnapshot,
	start = 0,
	end?: number
): string => {
	const effectiveEnd = end ?? snapshot.length
	ensureValidRange(snapshot, start, effectiveEnd)
	if (start === effectiveEnd) return ''

	const chunks: string[] = []
	collectTextInRange(
		snapshot.root,
		snapshot.buffers,
		start,
		effectiveEnd,
		chunks
	)
	return chunks.join('')
}

export const insertIntoPieceTable = (
	snapshot: PieceTableTreeSnapshot,
	offset: number,
	text: string
): PieceTableTreeSnapshot => {
	if (text.length === 0) return snapshot
	if (offset < 0 || offset > snapshot.length) {
		throw new RangeError('invalid offset')
	}

	const { buffers, piece } = appendToAddBuffer(snapshot, text)
	const insertionNode = createNode(piece)
	const { left, right } = splitByOffset(snapshot.root, offset)
	const merged = merge(merge(left, insertionNode), right)
	return createSnapshot(buffers, merged)
}

export const deleteFromPieceTable = (
	snapshot: PieceTableTreeSnapshot,
	offset: number,
	length: number
): PieceTableTreeSnapshot => {
	if (length <= 0) return snapshot
	ensureValidRange(snapshot, offset, offset + length)

	const { left, right } = splitByOffset(snapshot.root, offset)
	const { right: tail } = splitByOffset(right, length)
	const merged = merge(left, tail)
	return createSnapshot(snapshot.buffers, merged)
}

export const debugPieceTable = (snapshot: PieceTableTreeSnapshot): Piece[] =>
	flattenPieces(snapshot.root, [])
