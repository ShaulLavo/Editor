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

### Anchor Identity Across Undo

Anchors reference immutable buffers, not the treap. Resolvable against any snapshot. Same anchor may be live/deleted depending on snapshot. Undoing deletion restores liveness.

### Future: Operation-Based Undo

For collaboration: individual operations must be reversible without affecting concurrent ones. Deferred.
