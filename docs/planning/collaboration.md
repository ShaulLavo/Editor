# Collaboration Constraints

Collaboration is NOT a current design constraint. We avoid locking decisions for it until single-user is validated. But we must not make it structurally impossible.

## Structural Constraints

### 1. Buffer identity must be opaque

Collaboration needs per-replica add buffers. `PieceBufferId` must not be a two-value union.

**Status: compatible.** `PieceBufferId` is an opaque branded string.

### 2. Pieces must not rely on physical removal

Collaboration needs visibility flags (mark invisible, not remove). `subtreeVisibleLength` (Phase 2) preserves this path.

**Status: Phase 2 decision locked.** Deletes will mark pieces invisible for anchor resolution.

### 3. Reverse index keys must be extensible

Per-replica buffers need `(replicaId, buffer, offset)` keys. The Phase 2 `(buffer, piece.start)` interval key is extensible.

**Status: compatible.**

### 4. Edits must be first-class values

Operation-based undo and conflict resolution need reified edit objects. Current API returns snapshots but not edit objects.

**Status: partially compatible.** `Edit<D>` designed but not produced by piece table API.

## What This Does NOT Do

Does not design collaboration. Does not commit to CRDTs, OT, or any concurrency model. Identifies four properties that, if violated, require ground-up rewrite.
