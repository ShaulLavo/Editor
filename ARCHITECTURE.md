# Browser Code Editor — Architecture

## 1. Goals

- Ultra-low latency typing (target: <1-2ms perceived)
- Fully in-browser editor
- Heavy use of Web Workers
- Modular, decoupled architecture
- High performance on large files (MBs, long lines)
- High flexibility (future plugins, languages, features)

---

## 2. Non-Goals (for now)

- Collaboration (CRDT/OT) — maybe later (structural constraints preserved, see [Collaboration](docs/planning/collaboration.md))
- Full IDE features (LSP, etc.)
- Accessibility completeness
- Mobile-first UX

---

## 3. Core Principles

- Single canonical document model
- Everything else = derived projections
- Strict sync vs async split
- Minimal work on main thread
- Eventual consistency for non-critical systems
- Piece-based thinking (not whole document)

---

## 4. High-Level Architecture

### Main Thread (Sync / Immediate)
- Input handling
- Caret & selection
- Minimal text echo
- Minimal local layout (small piece range)
- Rendering / DOM / CSS highlights
- Reconciliation with worker

### Worker(s) (Async / Authoritative)
- Document model
- Transactions / edits
- Layout engine (full)
- Tokenization / parsing
- Decorations
- Scheduling

---

## 5. Core Systems

### 5.1 Document Engine (Locked)

Treap-backed piece table with persistent immutable snapshots.

See: [Storage: Piece Table](docs/storage/piece-table.md) for full design.
Implementation: `packages/editor/src/pieceTable/`

---

### 5.2 Transaction System

Batch edit API designed. Full transaction format still open.

See: [Editing: Selections & Undo](docs/editing/selections-and-undo.md) for batch edits.

**Open:** Full transaction format, where undo/redo lives (main vs worker).

---

### 5.3 Position Model (Locked)

Three-tier: Offset (UTF-16) -> Point (row/column) -> Anchor (durable buffer reference).

See: [Positions: Types & Conversions](docs/positions/types-and-conversions.md)
See: [Positions: Anchors](docs/positions/anchors.md)

---

### 5.4 Layout System

Work in progress — being designed separately. Will be reconciled once complete.

**Key principles (locked):** Piece-based, incremental from edit point.

**Open:** Layout unit, independent computation, tree vs flat, long line handling.

---

### 5.5 Sync vs Async Split

**Open:** How much layout on main, optimistic behavior scope, reconciliation strategy.

---

### 5.6 Invalidation Model

Display transform invalidation protocol designed. Layout/viewport/cache invalidation still open.

See: [Display: Transforms](docs/display/transforms.md) for the invalidation protocol.

---

### 5.7 Scheduling System

**Not yet designed.** Proposed priority levels: Critical (typing) > High (visible layout) > Medium (visible tokens) > Low (background parsing).

---

### 5.8 Decoration System

Constraints defined, design deferred. Dense decorations must not use per-token anchors.

See: [Display: Transforms](docs/display/transforms.md) for decoration constraints.

---

### 5.9 Viewport & Virtualization

**Not yet designed.**

---

### 5.10 Rendering Layer (Partially Implemented)

CSS Highlight API renderer implemented. See `packages/editor/src/editor.ts`.

---

## 6. Data Flow

### Typing Flow (Target)

1. Input event (main)
2. Minimal text update (main)
3. Minimal layout update (main)
4. Paint immediately
5. Send edit to worker
6. Worker updates document
7. Worker recomputes layout for affected pieces
8. Worker sends authoritative result
9. Main reconciles

---

## 7. Remaining Open Questions

1. ~~Position model?~~ **Locked.**
2. ~~Text storage structure?~~ **Locked.**
3. Layout unit model?
4. ~~Invalidation strategy?~~ **Partially designed.**
5. Main vs worker layout split?
6. Scheduler design?
7. Decoration system design?
