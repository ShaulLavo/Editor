# Scheduling

## Decision

The editor uses a two-level scheduler:

1. A small main-thread frame scheduler for input, mounted-row DOM work, selection paint, and
   viewport reconciliation.
2. A worker-side document scheduler for authoritative document transactions and derived
   projections such as syntax, folds, decorations, and background analysis.

Typing must not wait for derived work. Worker results are snapshot-tagged and may be dropped at any
consumer boundary if they no longer match the visible document state.

## Core Invariants

- Input echo, caret movement, and active selection changes are not queued behind async work.
- Authoritative document transactions are serialized per document.
- Derived projections are cancellable by supersession and stale by default.
- Visible work beats whole-document work.
- Main-thread work is frame-budgeted. Worker work is priority-budgeted.
- The scheduler never owns correctness. Snapshots, anchors, and version checks own correctness.

## Ownership

### Main Thread

The main thread owns latency-sensitive interaction:

- beforeinput/input event handling
- immediate local text echo for mounted rows
- DOM selection/caret synchronization
- scroll and viewport observation
- mounted-row reconciliation
- CSS Highlight API registry updates for visible ranges
- dispatching edit, viewport, and query requests to workers

Main-thread scheduling is frame based:

- Critical input work runs in the event handler and must stay under the typing budget.
- DOM reconciliation and highlight registry updates run in `requestAnimationFrame`.
- Optional cleanup uses `requestIdleCallback` or a timeout fallback.
- Main thread never runs Tree-sitter parsing or syntax queries.

### Worker

Workers own serialized document updates and derived projections:

- piece-table transaction application
- snapshot production
- undo/redo state if history moves off the main thread
- Tree-sitter parse and incremental reparse
- syntax query execution
- fold derivation
- decoration production and rebasing
- background indexing or analysis

The worker scheduler may use multiple worker pools later, but the first design is one scheduler per
document worker. Parser workers can be split out after the protocol is stable.

## Priority Lanes

| Lane | Examples | Rule |
|---|---|---|
| `critical` | Input echo, caret/selection update, mounted text mutation | Main-thread only; not delayed by queued work |
| `transaction` | Apply edit batch, produce snapshot, commit undo boundary | Serialized per document; always runs before derived worker work |
| `visible-layout` | Visible row/chunk window, scroll reconciliation, mounted highlight range updates | Latest viewport wins; frame-budgeted |
| `visible-syntax` | Visible-range highlight query, bracket match, fold query near viewport | Runs after needed transaction/parse; supersedes older visible requests |
| `interactive-query` | structural selection expand/shrink, go-to matching bracket | User-blocking async; may preempt background work |
| `background` | full-document parse continuation, offscreen highlights/folds, outline | Paused during typing bursts and dropped if stale |
| `idle` | cache trimming, diagnostics cleanup, prefetch | Runs only when no higher lane is pending |

`critical` is not a worker queue. It is the immediate path that keeps the editor responsive while
the worker catches up.

## Task Model

Scheduled worker tasks should carry:

- `documentId`
- `taskId`
- `lane`
- `baseSnapshotVersion`
- `targetSnapshotVersion`
- `coalesceKey`
- optional `visibleRange`
- optional dependency ids
- cancellation token

The scheduler may start a task only when its base snapshot is available. Consumers may apply a task
result only when `targetSnapshotVersion` still matches the consumer's current snapshot expectation.

## Coalescing And Cancellation

Coalescing is required, not an optimization.

| Work type | Coalescing rule |
|---|---|
| Viewport updates | Keep only the latest scroll/size/window per document |
| Visible syntax query | Keep only the latest visible range per snapshot and language |
| Background syntax query | Drop when a newer parse for the same document exists |
| Full parse | Keep newest target snapshot; older unstarted parses are removed |
| Decoration updates | Merge adjacent invalidations before dispatch |
| Structural selection | Latest user command wins unless the previous command already returned |

Cancellation is cooperative:

- Unstarted stale tasks are removed from queues.
- Running tasks check cancellation between phases.
- Non-yielding Tree-sitter parse calls cannot be interrupted mid-call, but their query and result
  publication phases must be cancellable.
- Stale results are safe to ignore even when cancellation was too late.

## Budgets

Main-thread budget targets:

- input handler: under 2 ms
- animation-frame DOM reconciliation: under 4 ms
- highlight registry update: visible ranges only; split if it risks a long frame

Worker budget targets:

- transaction lane: run immediately and finish before derived work
- visible syntax: first useful result within one frame after parse availability when possible
- interactive query: under 2 ms target after parse availability
- background lane: chunk to 4-8 ms slices where the operation is yieldable

If the system is over budget, it must reduce derived work quality before affecting typing:

1. Drop offscreen decorations.
2. Narrow syntax queries to the viewport.
3. Pause background parsing/querying.
4. Increase debounce for low-priority diagnostics.
5. Fall back to plain rendering for languages or files that exceed limits.

## Typing Flow

1. Main thread receives input.
2. Main thread updates mounted text/caret immediately.
3. Main thread sends an edit transaction request with the current snapshot version.
4. Worker serializes the edit, produces the next snapshot, and replies.
5. Main thread reconciles if the visible optimistic state differs.
6. Worker schedules visible syntax/fold/decorations for the new snapshot.
7. Background work resumes only after visible work drains or the editor is idle.

## Scroll Flow

1. Main thread receives scroll/resize.
2. Main thread coalesces viewport state to the next animation frame.
3. Main thread mounts the new row/chunk window.
4. Main thread requests visible syntax/decorations for the mounted range.
5. Worker drops older visible-range requests and returns only snapshot-tagged results.

## Starvation Policy

Background work can be delayed indefinitely during active typing. Interactive and visible work must
not starve:

- visible work older than 100 ms is promoted ahead of background work
- interactive queries run ahead of visible syntax after the active transaction is committed
- background tasks may run one slice after 2 seconds of continuous activity if no visible task is
  pending

Promotion never overrides transaction ordering.

## Backpressure

The worker reports pressure states to the main thread:

- `normal`: all lanes active
- `busy`: background paused, visible work narrowed
- `overloaded`: only transactions and visible viewport work continue
- `degraded`: syntax/decorations disabled for the current file until the next reset or explicit retry

Backpressure is per document. A huge file should not degrade smaller documents.

## Acceptance Criteria

- Typing remains responsive while syntax work is stale, slow, or failing.
- Transactions are applied in document order.
- Visible viewport work supersedes offscreen work.
- Stale worker results are always rejected by snapshot/version checks.
- Repeated scroll events produce one mounted-window update per animation frame.
- Repeated edits produce at most one active visible syntax request for the latest snapshot.
- Background parse/query work pauses under sustained typing and resumes when idle.
- The scheduler exposes timing counters per lane for performance tests.

## Open Implementation Choices

- Whether worker scheduling uses one document worker or a separate parser worker pool.
- Whether to use `scheduler.postTask` when available or keep a minimal local priority queue.
- Exact pressure thresholds for large files and slow devices.
- Final ownership of undo/redo once transactions move fully into the worker.
