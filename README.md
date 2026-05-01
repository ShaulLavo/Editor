# Singapore Editor

Singapore Editor is a browser-based code editor project focused on very low-latency editing,
persistent text storage, syntax-aware interactions, and browser-native rendering.

The name is a nod to Monaco Editor: another editor named after a city-state.

The editor core is built around a treap-backed piece table with immutable snapshots,
anchor-backed positions and selections, Tree-sitter syntax sessions, CSS Highlight API painting,
display transforms, fixed-row virtualization, long-line chunking, plugin-driven gutters, and a
worker-backed minimap.

## Status

This repository is an active implementation workspace. The API and package boundaries are still
moving, but the current codebase includes:

- Persistent piece-table storage with snapshot isolation and chunked append buffers.
- Offset/point conversion, durable anchors, anchor-backed selections, and undo/redo helpers.
- Multi-selection edits, keyboard navigation, fold state, and syntax-aware structural selection.
- Worker-backed Tree-sitter parsing/query support for syntax highlights and folds.
- Language plugins for JavaScript, TypeScript, TSX/JSX, HTML, CSS, and JSON.
- CSS Highlight API rendering scoped to mounted rows and long-line chunks.
- Fixed-row viewport virtualization with horizontal chunking for very long lines.
- Fold maps and display transform validation.
- Plugin APIs for gutters, view contributions, highlighters, themes, and language registration.
- Line and fold gutter packages.
- A worker-backed minimap package.
- A Vite example app with a file browser, editor pane, top bar, and status bar.
- A legacy Shiki highlighter plugin kept beside the Tree-sitter syntax path.

For the implementation history, see [PROGRESS.md](PROGRESS.md). For system design and open
architecture questions, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Packages

| Package | Purpose |
| --- | --- |
| `@editor/core` | Core editor, piece table, anchors, selections, syntax sessions, folds, transforms, virtualization, renderer, themes, and plugin contracts. |
| `@editor/gutters` | Line-number and fold-gutter plugins for the core editor. |
| `@editor/minimap` | Minimap plugin with worker-backed document rendering. |
| `@editor/tree-sitter-languages` | Tree-sitter language contributions and queries for JavaScript, TypeScript, HTML, CSS, and JSON. |
| `@editor/shiki` | Legacy/demo Shiki highlighter plugin. Tree-sitter is the main syntax direction. |
| `@editor/example-app` | Demo application using the editor, language plugins, gutters, minimap, and File System Access/GitHub-backed source browsing. |

## Requirements

- [Bun](https://bun.sh/) `1.3.10` or compatible.
- A modern browser with CSS Highlight API support for the full rendering path.
- Playwright browser dependencies for browser and e2e tests.

## Getting Started

Install dependencies:

```sh
bun install
```

Run the example app:

```sh
bun run dev
```

The root `dev` script runs Turborepo. The app itself lives in `examples/app` and is served by
Vite.

## Common Commands

Run the main workspace checks:

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

- [Architecture](ARCHITECTURE.md) - main-thread/worker split, core systems, data flow, and open questions.
- [Progress](PROGRESS.md) - implementation phases, validation history, and current open areas.
- [Storage: Piece Table](docs/storage/piece-table.md) - treap-backed storage model.
- [Positions: Types & Conversions](docs/positions/types-and-conversions.md) - offsets, points, and conversions.
- [Positions: Anchors](docs/positions/anchors.md) - durable position references.
- [Editing: Selections & Undo](docs/editing/selections-and-undo.md) - selection, batch edit, and history model.
- [Display: Transforms](docs/display/transforms.md) - transform layers and invalidation.
- [Display: Browser Virtualization](docs/display/browser-virtualization.md) - browser layout and viewport strategy.
- [Syntax: Tree-sitter](docs/syntax/tree-sitter.md) - syntax engine design.

## Source Layout

```text
packages/editor/                  Core editor package
packages/gutters/                 Line and fold gutter plugins
packages/minimap/                 Minimap plugin and worker renderer
packages/tree-sitter-languages/   Tree-sitter grammar/query plugin package
packages/shiki/                   Legacy Shiki highlighter plugin
examples/app/                     Demo app
docs/                             Design documents
opensrc/                          Local source references for selected dependencies
```

## Notes

Singapore Editor is optimized for design validation and performance work, not for publishing a
stable editor API yet. Prefer the design docs, tests, and package-local behavior as the source of
truth when changing core systems.
