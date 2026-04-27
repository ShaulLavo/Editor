import { performance } from "node:perf_hooks";

import {
  createDocumentSession,
  resolveSelection,
  type DocumentSession,
  type DocumentSessionChange,
  type PosttextLayoutMetrics,
  type PosttextViewport,
} from "../src";

type Scenario = {
  label: string;
  iterations: number;
  text: string;
  startOffset: number;
  viewportForOffset(session: DocumentSession, offset: number): PosttextViewport;
};

type TimingStats = {
  minMs: number;
  medianMs: number;
  p95Ms: number;
};

type ScenarioSample = {
  label: string;
  iterations: number;
  textLength: number;
  lineCount: number;
  sessionApply: TimingStats;
  layoutUpdate: TimingStats;
  liveQueries: TimingStats;
  totalTypingAndQuery: TimingStats;
  rebuildsDuringTyping: number;
  incrementalUpdates: number;
  checksum: number;
};

const metrics: PosttextLayoutMetrics = {
  charWidth: 8,
  lineHeight: 18,
  tabSize: 4,
  fontKey: "posttext-session-bench-monospace-13",
};

const MULTI_LINE_COUNT = 25_000;
const MULTI_LINE_WIDTH = 48;
const LONG_LINE_LENGTH = 80_000;

const formatMs = (value: number): string => `${value.toFixed(4)}ms`;

const repeatedLine = (line: number): string => {
  const prefix = `line-${line.toString().padStart(5, "0")}\t`;
  return `${prefix}${"x".repeat(MULTI_LINE_WIDTH - prefix.length)}`;
};

const createMultiLineText = (): string => {
  const lines: string[] = [];

  for (let line = 0; line < MULTI_LINE_COUNT; line += 1) {
    lines.push(repeatedLine(line));
  }

  return lines.join("\n");
};

const createLongLineText = (): string => {
  const chunks: string[] = [];

  for (let offset = 0; offset < LONG_LINE_LENGTH; offset += 1) {
    if (offset % 17 === 0) {
      chunks.push("\t");
      continue;
    }

    chunks.push(String.fromCharCode(97 + (offset % 26)));
  }

  return chunks.join("");
};

const timingStats = (values: readonly number[]): TimingStats => {
  const sorted = values.toSorted((left, right) => left - right);
  const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const middle = Math.floor(sorted.length / 2);

  return {
    minMs: sorted[0] ?? 0,
    medianMs: sorted[middle] ?? 0,
    p95Ms: sorted[p95Index] ?? 0,
  };
};

const timingDuration = (change: DocumentSessionChange, name: string): number => {
  return change.timings.find((timing) => timing.name === name)?.durationMs ?? 0;
};

const resolveHeadOffset = (session: DocumentSession): number => {
  const selection = session.getSelections().selections[0];
  if (!selection) return session.getSnapshot().length;

  return resolveSelection(session.getSnapshot(), selection).headOffset;
};

const queryLiveLayout = (session: DocumentSession, viewport: PosttextViewport): number => {
  const headOffset = resolveHeadOffset(session);
  const caret = session.getLayoutXY(headOffset);
  const visible = session.queryLayoutViewport(viewport);
  const boxes = session.getLayoutRangeBoxes(Math.max(0, headOffset - 24), headOffset);

  return caret.x + caret.y + visible.lines.length * 17 + boxes.length * 31;
};

const runScenario = (scenario: Scenario): ScenarioSample => {
  const session = createDocumentSession(scenario.text);
  session.setLayoutMetrics(metrics);
  session.setSelection(scenario.startOffset);

  const baseline = session.getLayoutSummary();
  const sessionApplySamples: number[] = [];
  const layoutUpdateSamples: number[] = [];
  const liveQuerySamples: number[] = [];
  const totalSamples: number[] = [];
  let checksum = 0;

  for (let iteration = 0; iteration < scenario.iterations; iteration += 1) {
    const totalStart = performance.now();
    const change = session.applyText(iteration % 8 === 7 ? "\n" : "x");
    const queryStart = performance.now();
    const headOffset = resolveHeadOffset(session);
    checksum += queryLiveLayout(session, scenario.viewportForOffset(session, headOffset));
    const queryDone = performance.now();

    sessionApplySamples.push(timingDuration(change, "session.applyText"));
    layoutUpdateSamples.push(timingDuration(change, "posttext.layout.incremental"));
    liveQuerySamples.push(queryDone - queryStart);
    totalSamples.push(queryDone - totalStart);
  }

  const finalSummary = session.getLayoutSummary();

  return {
    label: scenario.label,
    iterations: scenario.iterations,
    textLength: scenario.text.length,
    lineCount: baseline.lineCount,
    sessionApply: timingStats(sessionApplySamples),
    layoutUpdate: timingStats(layoutUpdateSamples),
    liveQueries: timingStats(liveQuerySamples),
    totalTypingAndQuery: timingStats(totalSamples),
    rebuildsDuringTyping: finalSummary.rebuildCount - baseline.rebuildCount,
    incrementalUpdates: finalSummary.incrementalUpdateCount - baseline.incrementalUpdateCount,
    checksum,
  };
};

const multiLineScenario = (): Scenario => {
  const text = createMultiLineText();
  const lineStride = MULTI_LINE_WIDTH + 1;
  const startOffset = lineStride * 12_000 + 8;

  return {
    label: "session typing/query in 25k-line document",
    iterations: 500,
    text,
    startOffset,
    viewportForOffset: (session, offset) => {
      const caret = session.getLayoutXY(offset);
      return {
        x1: 0,
        y1: Math.max(0, caret.y - metrics.lineHeight * 5),
        x2: 720,
        y2: caret.y + metrics.lineHeight * 8,
      };
    },
  };
};

const longLineScenario = (): Scenario => {
  const text = createLongLineText();
  const startOffset = Math.floor(text.length / 2);

  return {
    label: "session typing/query in long line",
    iterations: 200,
    text,
    startOffset,
    viewportForOffset: (session, offset) => {
      const caret = session.getLayoutXY(offset);
      return {
        x1: Math.max(0, caret.x - 320),
        y1: 0,
        x2: caret.x + 320,
        y2: metrics.lineHeight,
      };
    },
  };
};

const printStats = (label: string, stats: TimingStats): void => {
  console.log(
    `${label}: median ${formatMs(stats.medianMs)}, p95 ${formatMs(stats.p95Ms)}, min ${formatMs(
      stats.minMs,
    )}`,
  );
};

const printSample = (sample: ScenarioSample): void => {
  console.log(`posttext session benchmark: ${sample.label}`);
  console.log(`iterations: ${sample.iterations}`);
  console.log(`text length: ${sample.textLength.toLocaleString()}`);
  console.log(`initial logical lines: ${sample.lineCount.toLocaleString()}`);
  printStats("session applyText", sample.sessionApply);
  printStats("posttext incremental update", sample.layoutUpdate);
  printStats("live layout queries", sample.liveQueries);
  printStats("typing + live queries", sample.totalTypingAndQuery);
  console.log(`incremental updates during typing: ${sample.incrementalUpdates}`);
  console.log(`rebuilds during typing: ${sample.rebuildsDuringTyping}`);
  console.log(`checksum: ${sample.checksum.toFixed(0)}`);
  console.log("");
};

for (const scenario of [multiLineScenario(), longLineScenario()]) {
  printSample(runScenario(scenario));
}
