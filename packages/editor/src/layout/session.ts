import type { PieceTableSnapshot } from "../pieceTable";
import { applyNoWrapPosttextLayoutEdits, createNoWrapPosttextLayout } from "./noWrap";
import type {
  PosttextLayoutMetrics,
  PosttextLayoutSession,
  PosttextLayoutStats,
  PosttextLayoutUpdateMode,
  PosttextLayoutUpdateResult,
  PosttextTextEdit,
} from "./types";

export const DEFAULT_POSTTEXT_LAYOUT_METRICS: PosttextLayoutMetrics = {
  charWidth: 8,
  lineHeight: 18,
  tabSize: 4,
  fontKey: "editor-default-monospace-13",
};

const initialStats = (): PosttextLayoutStats => ({
  revision: 0,
  rebuildCount: 1,
  incrementalUpdateCount: 0,
  reuseCount: 0,
});

const incrementStats = (
  stats: PosttextLayoutStats,
  mode: PosttextLayoutUpdateMode,
): PosttextLayoutStats => ({
  revision: stats.revision + 1,
  rebuildCount: stats.rebuildCount + (mode === "rebuild" ? 1 : 0),
  incrementalUpdateCount: stats.incrementalUpdateCount + (mode === "incremental" ? 1 : 0),
  reuseCount: stats.reuseCount + (mode === "reuse" ? 1 : 0),
});

const sameMetrics = (left: PosttextLayoutMetrics, right: PosttextLayoutMetrics): boolean => {
  if (left.charWidth !== right.charWidth) return false;
  if (left.lineHeight !== right.lineHeight) return false;
  if (left.tabSize !== right.tabSize) return false;
  return left.fontKey === right.fontKey;
};

const sessionWithLayout = (
  session: PosttextLayoutSession,
  snapshot: PieceTableSnapshot,
  metrics: PosttextLayoutMetrics,
  mode: PosttextLayoutUpdateMode,
  edits: readonly PosttextTextEdit[],
): PosttextLayoutSession => {
  const layout =
    mode === "incremental"
      ? applyNoWrapPosttextLayoutEdits(session.layout, snapshot, edits)
      : createNoWrapPosttextLayout(snapshot, metrics);

  return {
    layout,
    stats: incrementStats(session.stats, mode),
  };
};

export const createPosttextLayoutSession = (
  snapshot: PieceTableSnapshot,
  metrics: PosttextLayoutMetrics = DEFAULT_POSTTEXT_LAYOUT_METRICS,
): PosttextLayoutSession => ({
  layout: createNoWrapPosttextLayout(snapshot, metrics),
  stats: initialStats(),
});

export const updatePosttextLayoutSession = (
  session: PosttextLayoutSession,
  snapshot: PieceTableSnapshot,
  edits: readonly PosttextTextEdit[],
): PosttextLayoutUpdateResult => {
  if (edits.length > 0) {
    return {
      session: sessionWithLayout(session, snapshot, session.layout.metrics, "incremental", edits),
      mode: "incremental",
    };
  }

  if (snapshot === session.layout.snapshot) {
    return {
      session: {
        layout: session.layout,
        stats: incrementStats(session.stats, "reuse"),
      },
      mode: "reuse",
    };
  }

  return {
    session: sessionWithLayout(session, snapshot, session.layout.metrics, "rebuild", []),
    mode: "rebuild",
  };
};

export const setPosttextLayoutSessionMetrics = (
  session: PosttextLayoutSession,
  metrics: PosttextLayoutMetrics,
): PosttextLayoutUpdateResult => {
  if (sameMetrics(session.layout.metrics, metrics)) {
    return {
      session: {
        layout: session.layout,
        stats: incrementStats(session.stats, "reuse"),
      },
      mode: "reuse",
    };
  }

  return {
    session: sessionWithLayout(session, session.layout.snapshot, metrics, "rebuild", []),
    mode: "rebuild",
  };
};
