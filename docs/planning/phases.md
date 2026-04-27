# Implementation Phases

## Phase 1: Storage Foundation + Line-Break Augmentation

Resolve storage prerequisites, extend treap with line-break tracking.

| Deliverable | Acceptance Criteria |
|---|---|
| Opaque `BufferId` type | `PieceBufferId` in `packages/editor/src/pieceTable/pieceTableTypes.ts` changed from `'original' \| 'add'` to opaque string. No string literal comparisons. |
| Chunked append buffer | Immutable chunks, each with own `BufferId`. Append O(1) amortized. 1000+ insertions = constant per-insertion time. |
| Piece.lineBreaks | Correct on creation and split |
| subtreeLineBreaks aggregate | Maintained through all operations in aggregate function pattern |
| offsetToPoint | Correct for all positions |
| pointToOffset | Round-trips with offsetToPoint; clamps out-of-range columns |

## Phase 2: Anchor System

Anchor type, creation, resolution (with liveness), comparison. Linear-scan first, then indexed.

| Deliverable | Acceptance Criteria |
|---|---|
| Anchor type + sentinels | MIN/MAX resolve correctly in all snapshots |
| anchorAt / anchorBefore / anchorAfter | Real anchors for all positions; live at creation |
| resolveAnchor (linear-scan) | Correct after inserts, deletes; returns liveness |
| subtreeVisibleLength aggregate | Maintained in aggregate function |
| Persistent reverse index | Keyed by (buffer, offset); O(log m); persistent; snapshot-isolated |
| Bridging | End-to-end resolution correct |
| Atomic snapshot production | Both roots produced atomically per edit |
| Correctness suite | Indexed matches linear-scan across all patterns |
| Benchmark | 10K, 50K, 100K-line: resolution time, index cost, memory, GC |
| applyBatch | k edits atomically, one snapshot, one undo entry |

## Phase 3: Selection Model

`Selection<T>`, `SelectionGoal`, multi-cursor with merge-on-overlap.

## Phase 4: Display Transform Validation

FoldMap as first layer. Go/no-go for the layered abstraction.

| Deliverable | Acceptance Criteria |
|---|---|
| FoldMap + FoldPoint | Bidirectional conversion, all fold configurations |
| Layer interface validation | Full contract works |
| Invalidation precision | Tight bounds: interior = no output; boundary = fold only; external = shifted |
| Round-trip correctness | All in-range positions |
| Edge cases | Line boundary folds, nested, document edges, edit inside fold |
| Performance baseline | Single-layer overhead; extrapolate multi-layer |
| Go/no-go decision | Based on invalidation precision |

## Phase 5: Additional Transforms (Conditional)

Only if FoldMap succeeds. Scope depends on Phase 4.
