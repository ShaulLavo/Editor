# Browser Code Editor — Architecture PRD (Draft / Half-Baked)

## 1. Goals

- Ultra-low latency typing (target: <1–2ms perceived)
- Fully in-browser editor
- Heavy use of Web Workers
- Modular, decoupled architecture
- High performance on large files (MBs, long lines)
- High flexibility (future plugins, languages, features)

---

## 2. Non-Goals (for now)

- Collaboration (CRDT/OT) — maybe later
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
- Fragment-based thinking (not whole document)

---

## 4. High-Level Architecture

### Main Thread (Sync / Immediate)
- Input handling
- Caret & selection
- Minimal text echo
- Minimal local layout (small fragment)
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

### 5.1 Document Engine (Canonical)

Responsibilities:
- Text storage
- Versioning
- Apply edits
- Produce snapshots
- Emit change sets

Open Questions:
- Data structure? (piece table / rope / custom)
- Internal encoding? (UTF-16 / UTF-8 / bytes)
- Snapshot API shape?

---

### 5.2 Transaction System

Responsibilities:
- Normalize all edits
- Support:
  - typing
  - delete
  - paste
  - multi-cursor
  - IME
  - undo/redo

Open Questions:
- Transaction format?
- Do we assign IDs to edits?
- Where does undo/redo live (main vs worker)?

---

### 5.3 Position Model

Responsibilities:
- Map offsets ↔ positions
- Support cursor movement & selection

Open Questions:
- Offset unit?
  - UTF-16?
  - Code points?
  - Grapheme clusters?
- Do we expose line/column or derive only?
- How do we handle surrogate pairs / emojis?

---

### 5.4 Layout System

Responsibilities:
- Compute visual positions
- Line wrapping
- Hit testing
- Virtualization support

Current Direction:
- Custom layout engine inspired by Pretext

Key Idea:
- Fragment-based layout (NOT full doc)
- Incremental updates from edit point

Open Questions:
- What is a fragment?
  - line?
  - paragraph?
  - fixed-size chunk?
- Can fragments be independently layouted?
- Do we keep layout tree or flat structure?
- How do we handle long lines?

---

### 5.5 Sync vs Async Split

Current Model:
- Main = minimal echo + small layout fragment
- Worker = authoritative everything

Open Questions:
- How much layout is allowed on main?
- Do we allow any "optimistic" behavior beyond text?
- What is the reconciliation strategy?

---

### 5.6 Invalidation Model

Responsibilities:
- Determine what recomputes on edit

Must cover:
- layout
- tokens
- decorations
- viewport
- caches

Open Questions:
- What is the invalidation unit?
- How far does layout invalidation propagate?
- Do we track dependencies explicitly?

---

### 5.7 Scheduling System

Responsibilities:
- Prioritize work

Priority Levels:
- Critical (typing, caret)
- High (visible layout)
- Medium (visible tokens)
- Low (background parsing)

Open Questions:
- Where does scheduler live?
- How do we cancel outdated work?
- Do we coalesce edits?

---

### 5.8 Decoration System

Responsibilities:
- Unified range-based system for:
  - syntax highlighting
  - selection
  - diagnostics
  - search results
  - inline widgets

Output:
- generic ranges → projected via CSS Highlight API

Open Questions:
- Range representation?
- Layering / priority model?
- How to handle overlapping decorations?

---

### 5.9 Viewport & Virtualization

Responsibilities:
- Render only visible content
- Map scroll ↔ document positions

Open Questions:
- What is the virtualization unit?
- How do we handle:
  - very long lines
  - mixed line heights
- Do we use prefix sums for heights?

---

### 5.10 Rendering Layer

Responsibilities:
- Compose:
  - text
  - highlights
  - selections
  - cursors
- Apply CSS Highlight API
- Interface with layout

Open Questions:
- DOM vs canvas vs hybrid?
- How do we map layout → DOM efficiently?
- Do we reuse nodes or fully diff?

---

## 6. Data Flow

### Typing Flow (Target)

1. Input event (main)
2. Minimal text update (main)
3. Minimal layout update (main)
4. Paint immediately

Then:

5. Send edit → worker
6. Worker updates document
7. Worker recomputes layout fragments
8. Worker sends authoritative result
9. Main reconciles

---

## 7. Performance Constraints

- Must handle:
  - MB-sized files
  - 10k+ lines
  - very long lines (50k+ chars)
- No main thread blocking
- Layout must be incremental

Open Questions:
- Worst-case strategy for long lines?
- Do we degrade features under load?

---

## 8. Future Considerations

- Plugins / extension system
- Language services (LSP)
- Collaboration
- Persistence

---

## 9. Biggest Open Questions (Summary)

1. What is the layout fragment unit?
2. What is the position model?
3. What is the text storage structure?
4. What is the invalidation strategy?
5. How much layout runs on main vs worker?
6. What is the scheduler design?

---

## 10. Next Step

Pick ONE and lock it:
- Position model
- Layout fragment model
- Document structure

Everything else depends on those.
