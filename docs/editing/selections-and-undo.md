# Selections & Undo

## Selection Model (Locked: Anchor-Based)

Editors need cursor positions and selected ranges that survive edits. Anchor-based selections are structurally stable — no rebasing required.

### Selection Type

Generic over position type: `Selection<T>` with `id`, `start: T`, `end: T`, `reversed`, `goal: SelectionGoal`.

- `reversed`: selection created by moving backward
- `goal`: preserves horizontal intent for vertical movement

### SelectionGoal

- **none** — no sticky position
- **horizontal** — pixel x-coordinate for arrow up/down
- **horizontalRange** — block/column selection

`SelectionGoal` lives with selection state because it describes the active selection's movement
intent. Pixel values are display-derived; the position layer never depends on them.

`horizontalRange` is represented in the type system now, but full block-selection geometry and
editing behavior remain deferred to the display/layout work.

### Storage

Active selections: array of `Selection<Anchor>`. Durable across edits. Resolved to screen coordinates at paint time.

**Normalization invariant:** sorted, no overlaps — treated as derived property, not eagerly maintained.

### Multi-Cursor

Multiple `Selection<Anchor>` entries. Cursor with no visible selection = start and end resolve to same offset.

### Lazy Normalization

Demand-driven, not per-edit.

**Must normalize:** before multi-selection edits, after edits that may cause overlap/reordering, before rendering/commands needing normalized form, after creating new selections.

**Can skip:** single-cursor typing/deletion/navigation, edits provably within one selection's span.

**Dirty-flag model:** normalization-valid flag on the array. Edits mark dirty; consumers normalize on demand.
The normalized flag is scoped to the snapshot used for normalization; a normalized selection set from
one snapshot must be normalized again before use with another snapshot.

### Normalization Semantics

- Resolve every selection to offsets in the current snapshot.
- Sort by resolved start, then resolved end, then id.
- Merge overlapping or touching ranges. Duplicate cursors at the same offset collapse to one cursor.
- The first selection in resolved order keeps its `id` when ranges merge.
- Merged selections are document-order selections: `reversed = false`, `goal = none`.
- Collapsed selections are never reversed.
- Deleted anchors are normalized through their resolved visible gap offsets. Normalization may replace
  deleted endpoint anchors with live anchors at the resolved offsets.

### Risks

- 100+ cursor normalization cost: O(k log n)
- Dirty-flag must be conservative (false positives OK, false negatives = bugs)
- SelectionGoal pixel dependency on display layer
- Block selection not designed end-to-end

---

## Batch Edits

Atomic multi-edit for multi-cursor typing, find-replace, format-on-save.

**Ordering contract:** offsets against *original* snapshot. Implementation adjusts internally. No overlap allowed.

**Implementation:** sort descending, apply sequentially. One snapshot + one undo entry.

**Cost:** O(k log n) for k edits.

### Selection-Aware Editing

Initial command surface:

- replace every active selection/cursor with the same text
- delete selected ranges
- backspace collapsed cursors by UTF-16 code point, preserving surrogate pairs

Selection edits normalize first, produce non-overlapping offset edits against the original snapshot,
apply them through `applyBatchToPieceTable`, then collapse each edited selection to the post-edit
caret position.

---

## Edit Representation

`Edit<D>`: `old: { start: D, end: D }`, `new: { start: D, end: D }`. For buffer ops, D = Offset.

`Patch`: ordered non-overlapping Edits. Composable: `compose(A, B)` = old-to-new directly.

Consumers: decoration rebase, display layer invalidation.

**Current edit type:** `TextEdit` in `packages/editor/src/tokens.ts`.

---

## Undo / Redo

### Snapshot-Based

Two stacks (undo, redo). Edit pushes current to undo, clears redo. Undo pushes to redo, pops undo.

With anchor resolution: snapshot = `(treapRoot, reverseIndexRoot)` tuple. Switch = O(1) root swap. Memory-efficient via structural sharing.

Phase 3 stores snapshots and selection state together in history entries. Undo and redo stacks are
linked stacks so push/pop snapshot switching stays O(1). This keeps selection restoration explicit
while preserving the anchor property that selections can still resolve across snapshots.

### Anchor Identity Across Undo

Anchors reference immutable buffers, not the treap. Resolvable against any snapshot. Same anchor may be live/deleted depending on snapshot. Undoing deletion restores liveness.

### Future: Operation-Based Undo

For collaboration: individual operations must be reversible without affecting concurrent ones. Deferred.
