# Anchor System

## Semantics (Locked)

- Anchors are stable references into immutable buffers
- Structurally immutable — never change across edits
- Resolved relative to a snapshot
- Always resolve to a document offset
- Deterministic: given (anchor, snapshot), resolution always produces the same offset and liveness
- May refer to live or deleted text
- Deletion changes liveness, not identity
- Liveness determined at resolution time, not creation time
- Bias (left/right) controls boundary behavior at insertion points
- An anchor may be live in one snapshot and deleted in another (e.g., across undo/redo)

### Why anchors (locked rationale)

- Eliminates rebasing at call sites
- Natural fit with piece table's immutable buffer model
- Proven in Zed at scale
- Liveness model gives consumers clear information

### Alternatives evaluated

1. **Explicit rebasing (CodeMirror-style):** Every call site must remember to rebase. Subtle bugs when forgotten.
2. **Interval tree tracking (VS Code-style):** Central maintenance cost and registration overhead.
3. **Offset-only (current state):** Meaningless after any edit.

---

## Creating Anchors

`anchorAt(snapshot, offset, bias)`:

1. **Validate offset.** Must be at a code-point boundary — rejects mid-surrogate-pair offsets.
2. Walk treap to find containing Piece.
3. Compute buffer-relative offset: `piece.start + (offset - pieceStartInDocument)`.
4. Return `{ buffer: piece.buffer, offset: bufferRelativeOffset, bias }`.

Always creates a real anchor. Never returns sentinels. Callers wanting absolute start/end must use `Anchor.MIN` / `Anchor.MAX` explicitly.

Convenience: `anchorBefore` = left bias, `anchorAfter` = right bias.

**Reference:** Treap walk and buffer structure in `packages/editor/src/pieceTable/pieceTable.ts`. Piece type in `packages/editor/src/pieceTable/pieceTableTypes.ts`.

---

## Deletion and Bias Rules (Locked)

Resolution produces `ResolvedAnchor`: `{ offset, liveness }`.

- **Live:** exact visible position. Liveness = `live`.
- **Deleted:** gap where text used to be. Liveness = `deleted`.
- **Bias at gap:** Left = left edge, Right = right edge.
- **Replacement (delete + insert):** delete-first, then insert. Left-biased stays before new text; right-biased stays after.
- **Boundary clamping:** clamps to 0 / document.length at document edges.
- **Deterministic** for a given (anchor, snapshot) pair.
- **Replacement is not a special case.** Fully defined by delete-first + bias.

---

## Resolution Architecture (Locked)

Two persistent structures:

### 1. Persistent reverse index

Persistent balanced BST keyed by `(buffer, offset)`. O(log m) predecessor search finds the piece covering an anchor's buffer position (or gap neighbors for deleted anchors).

Does NOT store document offsets. Answers only: "which piece contains this buffer position?"

Persistent via structural sharing (path copying). Each edit produces a new root.

### 2. Enriched persistent treap (prefix sums)

Treap enriched with `subtreeVisibleLength` aggregates, maintained in the same aggregate function as `subtreeLength` (see `packages/editor/src/pieceTable/pieceTable.ts`). Zero additional per-edit cost.

Serves as both ordered piece container and prefix-sum structure. No Fenwick tree needed.

**Why Fenwick rejected:** Flat arrays with no structural-sharing seam — incompatible with persistent snapshots. Also duplicates info already in the treap.

### Bridging (locked: direct node reference)

Reverse index stores direct reference to treap node. O(1) bridging. Safe because persistent nodes are immutable.

### Resolution flow

1. If sentinel, return immediately.
2. Reverse index lookup: find covering piece.
3. Live: compute document offset via visible-length prefix sum.
4. Deleted: apply bias, compute offset via prefix sums.

---

## Snapshot Consistency (Locked)

Snapshot = `(treapRoot, reverseIndexRoot)` tuple. Both immutable. Undo/redo = O(1) root swap.

| Structure | Per-edit cost | Memory per delta |
|---|---|---|
| Enriched treap | O(log n) nodes (already happening) | ~64 bytes/node |
| Reverse index | O(log m) nodes via path copying | ~64 bytes/node |

**GC safety:** Reverse index points to treap nodes reachable from the same snapshot's treap root. Dropping a snapshot drops both roots. **Invariant:** snapshots must be retained/discarded as complete tuples — never expose roots individually.

### Comparing Anchors

`compareAnchors(snapshot, a, b)` resolves both to offsets. Same offset: left bias < right bias.

---

## Consumer Direction (Locked)

| Consumer | Uses anchors? |
|---|---|
| Selections, folds, widgets | Yes |
| Layout | No (offsets/Points only) |
| Dense decorations (syntax, lint) | Coarse only (per-line/region, not per token) |

---

## What Still Needs Validation

- Write-path overhead constant factor and GC pressure under rapid editing
- Deleted resolution against real editing patterns (delete-and-retype, replace, multi-cursor)
- Debug inspector for opaque anchors
- Memory characteristics of thousands of small anchor objects in GC'd runtime
- Whether Zed model translates to JS (ownership semantics, zero-cost abstractions absent)
