import type { PieceTableSnapshot } from "../pieceTable";

export type PosttextLayoutMetrics = {
  charWidth: number;
  lineHeight: number;
  tabSize: number;
  fontKey: string;
};

export type PosttextXY = {
  x: number;
  y: number;
};

export type PosttextRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PosttextViewport = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type PosttextTextEdit = {
  from: number;
  to: number;
  text: string;
};

export type PosttextLayoutUpdateMode = "reuse" | "incremental" | "rebuild";

export type PosttextLineBoundary = {
  offset: number;
  x: number;
};

export type PosttextLineChunk = {
  startOffset: number;
  length: number;
  x: number;
  width: number;
  startColumn: number;
  endColumn: number;
  hasTabs: boolean;
  boundaries: readonly PosttextLineBoundary[];
};

export type PosttextLineLayout = {
  text: string;
  length: number;
  breakLength: number;
  chunks: readonly PosttextLineChunk[];
  width: number;
};

export type PosttextLineRun = {
  startRow: number;
  startOffset: number;
  lines: readonly PosttextLineLayout[];
  firstLine: number;
  lineCount: number;
  textLength: number;
  width: number;
};

export type PosttextLineIndex = {
  runs: readonly PosttextLineRun[];
  lineCount: number;
  textLength: number;
};

export type PosttextViewportLine = {
  row: number;
  startOffset: number;
  endOffset: number;
  visibleStartOffset: number;
  visibleEndOffset: number;
  rect: PosttextRect;
};

export type PosttextViewportResult = {
  viewport: PosttextViewport;
  lines: PosttextViewportLine[];
};

export type PosttextRangeBox = {
  row: number;
  startOffset: number;
  endOffset: number;
  rect: PosttextRect;
};

export type PosttextLayout = {
  snapshot: PieceTableSnapshot;
  metrics: PosttextLayoutMetrics;
  lineIndex: PosttextLineIndex;
  width: number;
  height: number;
};

export type PosttextLayoutStats = {
  revision: number;
  rebuildCount: number;
  incrementalUpdateCount: number;
  reuseCount: number;
};

export type PosttextLayoutSession = {
  layout: PosttextLayout;
  stats: PosttextLayoutStats;
};

export type PosttextLayoutUpdateResult = {
  session: PosttextLayoutSession;
  mode: PosttextLayoutUpdateMode;
};
