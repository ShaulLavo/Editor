# Storage Engine: Treap-Backed Piece Table

## Status: Implemented and Proven

The editor's storage engine is a treap-backed piece table with persistent immutable snapshots via structural sharing. Each mutation returns a new snapshot; previous snapshots remain valid and unmodified.

**Implementation:** `packages/editor/src/pieceTable/`
**Types:** `packages/editor/src/pieceTable/pieceTableTypes.ts`
**Operations:** `packages/editor/src/pieceTable/pieceTable.ts`

## Locked Decisions

- Treap-backed piece table as the storage engine
- Persistent (immutable-snapshot) data model for undo
- Two logical buffers: original + append-only add buffer (append-only semantics locked)
- UTF-16 code units as the native encoding
- Line-ending normalization to `\n` on load

## Capabilities

| Capability | Complexity | Notes |
|---|---|---|
| Insert text at offset | O(log n) | Split treap at offset, merge with new node |
| Delete text range | O(log n) | Split twice, discard middle |
| Read text range | O(log n + k) | Tree walk collecting piece slices |
| Snapshot isolation | O(1) | Structural sharing; old roots remain valid |
| Document length | O(1) | Cached in `subtreeLength` aggregate |
| Piece count | O(1) | Cached in `subtreePieces` aggregate |

## The Piece

The editor has one fundamental text-slice record: the **piece**. There is no second slice abstraction. A piece is a descriptor (`buffer`, `start`, `length`) pointing into one of the buffers via a `PieceBufferId`.

A piece's `(buffer, start)` pair serves as its insertion identity — no separate `insertionId` field is needed. The anchor model (see [Anchors](../positions/anchors.md)) builds on this identity without introducing new record types.

## Aggregate Maintenance Pattern (Locked)

All subtree aggregates (`subtreeLength`, `subtreePieces`, and future additions like `subtreeLineBreaks`, `subtreeVisibleLength`) are computed in a single function pattern. `createNode` delegates to aggregate computation; every site that reassigns children recomputes aggregates on the result. There is no separate update that mutates individual fields — partial aggregate updates are structurally impossible. Adding a new aggregate means adding it to the aggregate function and the `PieceTreeNode` type.

## Enrichment Roadmap

**Phase 1 — Line breaks:**
- Piece gains `lineBreaks` field (newline count in its buffer slice)
- Treap node gains `subtreeLineBreaks` aggregate
- Enables O(log n) offset-to-row/column conversion

**Phase 2 — Anchor resolution:**
- Treap node gains `subtreeVisibleLength` aggregate (maintained identically to `subtreeLength`)
- In single-user model, `subtreeVisibleLength === subtreeLength` (all pieces visible)
- Added now to establish infrastructure before visibility flags exist

**Future — Collaboration:**
- Piece gains `visible: boolean` field
- Deletion marks pieces invisible rather than removing from treap
- `subtreeVisibleLength` becomes load-bearing (sums only visible pieces)

## Phase 1 Prerequisites

### Opaque BufferId

**Current state (violated):** `PieceBufferId` is `'original' | 'add'` — a two-value union throughout the codebase.

**Required:** Change to opaque `BufferId` (`string`) before Phase 2 anchors bake in the two-buffer assumption. The change is mechanical: replace the union with a type alias and update comparisons.

### Chunked Append Buffer

**Current state:** Single JS string re-created via `old + text` on every insertion. O(total_buffer_size) per insertion, generates full-size garbage for GC.

**Required:** Immutable chunks of bounded size. Each chunk gets its own `BufferId`. Pieces reference chunk identity plus local range. Append is O(1) amortized. Buffer map becomes `Map<BufferId, string>`.

**Alternatives rejected:**
- Single string: O(n) per insertion. Unacceptable.
- Rope: Unnecessary — the piece table already provides the tree structure.
