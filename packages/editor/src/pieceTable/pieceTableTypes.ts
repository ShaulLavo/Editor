export type PieceBufferId = 'original' | 'add'

export type Piece = {
	buffer: PieceBufferId
	start: number
	length: number
}

export type PieceTableBuffers = {
	original: string
	add: string
}

export type PieceTreeNode = {
	piece: Piece
	left: PieceTreeNode | null
	right: PieceTreeNode | null
	priority: number
	subtreeLength: number
	subtreePieces: number
}

export type PieceTableTreeSnapshot = {
	buffers: PieceTableBuffers
	root: PieceTreeNode | null
	length: number
	pieceCount: number
}

export type PieceTableSnapshot = PieceTableTreeSnapshot
