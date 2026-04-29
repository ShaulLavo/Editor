# Editor

A browser-based code editor prototype focused on ultra-low-latency typing, persistent text storage,
syntax-aware editing, and browser-backed rendering.

The core editor is built around a treap-backed piece table with immutable snapshots, anchor-backed
positions and selections, CSS Highlight API rendering, Tree-sitter syntax infrastructure, display
transforms, and fixed-row viewport virtualization.

## Status

This project is an active research and implementation workspace. The current implementation includes:

- Persistent piece-table storage with snapshot isolation.
- Line/point conversion and anchor resolution.
- Anchor-backed selections, multi-selection edits, and undo/redo helpers.
- Tree-sitter worker-side syntax parsing/query infrastructure.
- Fold maps and display transform validation.
- Browser-backed fixed-row virtualization with long-line horizontal chunking.
- CSS Highlight API rendering.
- A minimap package.
- A Vite example app with file browser integration.

For the detailed implementation record, see [PROGRESS.md](PROGRESS.md). For the system design, see
[ARCHITECTURE.md](ARCHITECTURE.md).

## Packages

| Package | Purpose |
| --- | --- |
| `@editor/core` | Core editor, piece table, anchors, selections, syntax, folds, virtualization, and renderer. |
| `@editor/minimap` | Minimap plugin and worker-backed rendering helpers. |
| `@editor/shiki` | Legacy/demo Shiki tokenizer plugin. Tree-sitter is the committed long-term syntax path. |
| `@editor/example-app` | Demo application with File System Access API browser and editor integration. |

## Requirements

- [Bun](https://bun.sh/) `1.3.10` or compatible.
- A browser with the CSS Highlight API for the full editor experience.
- Playwright browser dependencies for browser/e2e tests.

## Getting Started

Install dependencies:

```sh
bun install
```

Run the example app:

```sh
bun run dev
```

The dev command runs through Turborepo. The example app is in `examples/app` and is served by Vite.

## Common Commands

Run all workspace checks:

```sh
bun run typecheck
bun run test
bun run lint
bun run build
```

Format the workspace:

```sh
bun run format
```

Check formatting without writing changes:

```sh
bun run format:check
```

Run package-specific browser tests:

```sh
bun --cwd packages/editor run test:browser
bun --cwd packages/minimap run test:browser
bun --cwd packages/shiki run test:browser
```

Run the example app e2e tests:

```sh
bun --cwd examples/app run test:e2e
```

## Benchmarks

Editor benchmarks live in `packages/editor/bench`:

```sh
bun --cwd packages/editor run bench:piece-table
bun --cwd packages/editor run bench:anchors
bun --cwd packages/editor run bench:syntax
bun --cwd packages/editor run bench:fold-map
bun --cwd packages/editor run bench:transforms
bun --cwd packages/editor run bench:virtualization
```

## Documentation

- [Architecture](ARCHITECTURE.md) - main-thread/worker split, core systems, and data flow.
- [Progress](PROGRESS.md) - completed phases, validation history, and open areas.
- [Storage: Piece Table](docs/storage/piece-table.md) - treap-backed storage model.
- [Positions: Types & Conversions](docs/positions/types-and-conversions.md) - offsets, points, and conversions.
- [Positions: Anchors](docs/positions/anchors.md) - durable position references.
- [Editing: Selections & Undo](docs/editing/selections-and-undo.md) - selection and history model.
- [Display: Transforms](docs/display/transforms.md) - transform layers and invalidation.
- [Display: Browser Virtualization](docs/display/browser-virtualization.md) - browser layout and viewport strategy.
- [Syntax: Tree-sitter](docs/syntax/tree-sitter.md) - syntax engine design.
- [Planning](docs/planning/phases.md) - implementation phases and acceptance criteria.

## Source Layout

```text
packages/editor/   Core editor package
packages/minimap/  Minimap package
packages/shiki/    Legacy Shiki tokenizer plugin
examples/app/      Demo app
docs/              Design and planning documents
opensrc/           Local source references for selected dependencies
```

## Notes

The repository is optimized for design validation and performance work, not for publishing a stable
editor API yet. Prefer the design docs and tests as the source of truth when changing core behavior.
