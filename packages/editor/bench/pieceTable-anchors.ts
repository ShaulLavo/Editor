import { performance } from "node:perf_hooks";

import {
  anchorAfter,
  createPieceTableSnapshot,
  insertIntoPieceTable,
  resolveAnchor,
  type RealAnchor,
} from "../src/pieceTable";

type Sample = {
  lines: number;
  pieces: number;
  anchors: number;
  textLength: number;
  indexBuildMs: number;
  averageResolveMs: number;
  heapUsedMb: number;
};

const LINE_BATCH_SIZE = 100;
const LINE_COUNTS = [10_000, 50_000, 100_000] as const;
const ANCHOR_STRIDE = 1_000;

const formatMs = (value: number): string => `${value.toFixed(4)}ms`;

const makeLineBatch = (startLine: number): string => {
  const lines: string[] = [];

  for (let index = 0; index < LINE_BATCH_SIZE; index++) {
    lines.push(`line-${startLine + index}\n`);
  }

  return lines.join("");
};

const buildSnapshot = (lineCount: number) => {
  let snapshot = createPieceTableSnapshot("");

  for (let line = 0; line < lineCount; line += LINE_BATCH_SIZE) {
    snapshot = insertIntoPieceTable(snapshot, snapshot.length, makeLineBatch(line));
  }

  return snapshot;
};

const createAnchors = (snapshot: ReturnType<typeof createPieceTableSnapshot>): RealAnchor[] => {
  const anchors: RealAnchor[] = [];

  for (let offset = 0; offset <= snapshot.length; offset += ANCHOR_STRIDE) {
    anchors.push(anchorAfter(snapshot, offset));
  }

  return anchors;
};

const measure = (lineCount: number): Sample => {
  const snapshot = buildSnapshot(lineCount);
  const anchors = createAnchors(snapshot);

  const indexStart = performance.now();
  resolveAnchor(snapshot, anchors[0]);
  const indexBuildMs = performance.now() - indexStart;

  const resolveStart = performance.now();
  for (const anchor of anchors) resolveAnchor(snapshot, anchor);
  const resolveMs = performance.now() - resolveStart;

  return {
    lines: lineCount,
    pieces: snapshot.pieceCount,
    anchors: anchors.length,
    textLength: snapshot.length,
    indexBuildMs,
    averageResolveMs: resolveMs / anchors.length,
    heapUsedMb: process.memoryUsage().heapUsed / 1024 / 1024,
  };
};

const printSample = (sample: Sample): void => {
  console.log(`anchor benchmark: ${sample.lines.toLocaleString()} lines`);
  console.log(`pieces: ${sample.pieces}`);
  console.log(`anchors: ${sample.anchors}`);
  console.log(`text length: ${sample.textLength}`);
  console.log(`lazy index build: ${formatMs(sample.indexBuildMs)}`);
  console.log(`average indexed resolve: ${formatMs(sample.averageResolveMs)}`);
  console.log(`heap used: ${sample.heapUsedMb.toFixed(2)} MiB`);
};

for (const lineCount of LINE_COUNTS) {
  printSample(measure(lineCount));
}
