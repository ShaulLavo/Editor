import { expect, test } from 'bun:test'
import {
	createPieceTableSnapshot,
	deleteFromPieceTable,
	getPieceTableText,
	insertIntoPieceTable,
} from './index'

test('piece table basic insert/delete round-trip', () => {
	let snapshot = createPieceTableSnapshot('hello')
	expect(getPieceTableText(snapshot)).toBe('hello')

	snapshot = insertIntoPieceTable(snapshot, 5, ' world')
	expect(getPieceTableText(snapshot)).toBe('hello world')

	snapshot = deleteFromPieceTable(snapshot, 5, 1)
	expect(getPieceTableText(snapshot)).toBe('helloworld')
})
