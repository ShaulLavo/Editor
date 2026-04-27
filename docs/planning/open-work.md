# Open Work

Consolidated validation, design, and measurement tasks.

## Blocking Implementation (Phase 2)

- Add `Piece.visible` and convert delete from physical removal to invisible-piece marking
- Implement `subtreeVisibleLength` aggregate on treap nodes
- Switch user-facing document length/offset prefix sums to visible length
- Implement persistent balanced BST reverse index keyed by `(buffer, piece.start)` intervals
- Implement bridging: reverse index to treap node to prefix-sum walk
- Verify atomic snapshot production
- Verify indexed resolution matches linear-scan baseline

## Anchor Validation

- Deletion/bias against real patterns: delete-and-retype, replace, multi-cursor, boundary clamping
- Gap-boundary resolution: delete word, line, everything
- Replacement: delete "abc", insert "xyz", verify bias
- Boundary clamping at document edges
- Sentinel vs real anchor at boundaries
- Piece-boundary creation: left bias chooses left piece end; right bias chooses right piece start
- Invisible pieces remain resolvable after delete and across undo/redo
- Surrogate-pair enforcement and fuzz testing

## Coordinate Validation

- Benchmark offset-vs-point as canonical coordinate
- Validate Offset intermediary for Point-heavy workloads
- Consider caching in `anchorToPoint`
- Validate `SelectionGoal` pixel values against the eventual display/layout layer

## Display Validation

- FoldMap end-to-end prototype
- FoldMap invalidation precision (go/no-go)
- Conversion benchmark through FoldMap
- Fold-boundary edge cases
- If FoldMap succeeds: design next layer (likely wrapping)

## Undo/Redo Validation

- Liveness transitions across undo/redo with interleaved edits
- Rapid undo/redo performance
- Create, delete, undo, redo, undo — verify liveness toggles
- Decide final ownership boundary for history once worker transactions are introduced

## Scale Validation

- Baseline benchmarks before new features
- Define "representative editing patterns"
- Multi-cursor targets (100 cursors x FoldMap)
- 50K+ line stress tests
- GC profiling under rapid editing
- 100+ edits without resolving, then resolve all

## Storage Validation

- Chunked buffer: constant per-insertion time, bounded GC, large paste handling
- Undo/redo-heavy storage benchmarks

## Testing Strategy

- Round-trip invariants for all conversions
- Edit stability: random edits, verify anchor resolution
- Multi-snapshot consistency: old snapshots intact after new edits
- Display layer isolation tests
- Fuzz testing: random insert/delete/anchor sequences
- Surrogate pair handling with emoji and non-BMP characters
