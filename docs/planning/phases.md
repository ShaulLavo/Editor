# Implementation Phases

## Phase 1: Storage Foundation + Line-Break Augmentation

Resolve storage prerequisites, extend treap with line-break tracking.

| Deliverable | Acceptance Criteria |
|---|---|
| Opaque `BufferId` type | Complete. `PieceBufferId` is an opaque branded string. No string literal comparisons. |
| Chunked append buffer | Complete. Immutable chunks, each with own `BufferId`. Append O(1) amortized. 1000+ insertions = constant per-insertion time. |
| Piece.lineBreaks | Complete. Correct on creation and split. |
| subtreeLineBreaks aggregate | Complete. Maintained through all operations in aggregate function pattern. |
| offsetToPoint | Complete. Correct for all positions. |
| pointToOffset | Complete. Round-trips with offsetToPoint; clamps out-of-range columns. |

## Phase 2: Anchor System

Anchor type, creation, resolution (with liveness), comparison. Linear-scan first, then indexed.

| Deliverable | Acceptance Criteria |
|---|---|
| Anchor type + sentinels | MIN/MAX resolve correctly in all snapshots |
| anchorAt / anchorBefore / anchorAfter | Real anchors for all positions; live at creation |
| Boundary creation | At piece boundaries, left bias anchors to the left piece end; right bias anchors to the right piece start |
| Invisible-piece deletion | `Piece.visible` exists; delete marks pieces invisible; user-facing length/offsets count only visible pieces |
| resolveAnchor (linear-scan) | Correct after inserts, deletes; returns liveness |
| subtreeVisibleLength aggregate | Maintained in aggregate function; invisible pieces contribute 0 |
| Persistent reverse index | Keyed by piece interval start `(buffer, piece.start)`; O(log m); persistent; snapshot-isolated |
| Bridging | End-to-end resolution correct |
| Atomic snapshot production | Both roots produced atomically per edit |
| Correctness suite | Indexed matches linear-scan across all patterns |
| Benchmark | 10K, 50K, 100K-line: resolution time, index cost, memory, GC |
| applyBatch | k edits atomically, one snapshot, one undo entry |

## Phase 3: Selection Model

`Selection<T>`, `SelectionGoal`, multi-cursor with merge-on-overlap.

| Deliverable | Acceptance Criteria |
|---|---|
| `Selection<T>` | Complete. Generic selection type with id, start/end, reversed, and goal. |
| `SelectionGoal` | Complete. Stored with selections; pixel values remain display-derived. |
| Anchor-backed selections | Complete. Active state can be represented as `Selection<Anchor>[]`. |
| Lazy normalization | Complete. `SelectionSet` carries a snapshot-scoped normalization-valid flag; consumers normalize on demand. |
| Merge semantics | Complete. Resolved ranges sort by offset and merge when overlapping or touching. |
| Selection edits | Complete. Text replacement and backspace produce batch edits against the original snapshot. |
| Undo boundary | Complete. Minimal O(1) linked-stack history helper stores snapshots and selection state together. |

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
