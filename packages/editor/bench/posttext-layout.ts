import { performance } from "node:perf_hooks";

import {
  applyBatchToPieceTable,
  applyNoWrapPosttextLayoutEdits,
  createNoWrapPosttextLayout,
  createPieceTableSnapshot,
  getPosttextRangeBoxes,
  posttextOffsetToXY,
  posttextXYToOffset,
  profileNoWrapPosttextLayoutBuild,
  queryNoWrapPosttextViewport,
  type PieceTableSnapshot,
  type PosttextLayout,
  type PosttextLayoutMetrics,
  type PosttextTextEdit,
} from "../src";

type Scenario = {
  label: string;
  iterations: number;
  snapshot: PieceTableSnapshot;
  layout: PosttextLayout;
  nextSnapshot: PieceTableSnapshot;
  edit: PosttextTextEdit;
  offsetProbe: number;
  xyProbe: { x: number; y: number };
  viewport: { x1: number; y1: number; x2: number; y2: number };
  range: { start: number; end: number };
};

type Sample = {
  label: string;
  iterations: number;
  samples: number;
  textLength: number;
  lineCount: number;
  fresh: TimingStats;
  incremental: TimingStats;
  buildLines: TimingStats;
  createRuns: TimingStats;
  buildTotal: TimingStats;
  medianSpeedup: number;
  minSpeedup: number;
  checksum: number;
};

type TimingStats = {
  minMs: number;
  medianMs: number;
};

type Measurement = {
  averageMs: number;
  checksum: number;
};

const metrics: PosttextLayoutMetrics = {
  charWidth: 8,
  lineHeight: 18,
  tabSize: 4,
  fontKey: "posttext-bench-monospace-13",
};

const LONG_LINE_LENGTH = 80_000;
const MULTI_LINE_COUNT = 25_000;
const MULTI_LINE_WIDTH = 48;
const LONG_LINE_ITERATIONS = 50;
const MULTI_LINE_ITERATIONS = 10;
const SAMPLE_COUNT = 7;

const formatMs = (value: number): string => `${value.toFixed(4)}ms`;

const repeatedLine = (line: number): string => {
  const prefix = `line-${line.toString().padStart(5, "0")}\t`;
  return `${prefix}${"x".repeat(MULTI_LINE_WIDTH - prefix.length)}`;
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

const createMultiLineText = (): string => {
  const lines: string[] = [];

  for (let line = 0; line < MULTI_LINE_COUNT; line += 1) {
    lines.push(repeatedLine(line));
  }

  return lines.join("\n");
};

const makeScenario = (
  label: string,
  text: string,
  edit: PosttextTextEdit,
  iterations: number,
  probes: Pick<Scenario, "offsetProbe" | "xyProbe" | "viewport" | "range">,
): Scenario => {
  const snapshot = createPieceTableSnapshot(text);
  const layout = createNoWrapPosttextLayout(snapshot, metrics);
  const nextSnapshot = applyBatchToPieceTable(snapshot, [edit]);

  return {
    label,
    iterations,
    snapshot,
    layout,
    nextSnapshot,
    edit,
    ...probes,
  };
};

const createLongLineScenario = (): Scenario => {
  const text = createLongLineText();
  const edit = {
    from: Math.floor(text.length / 2),
    to: Math.floor(text.length / 2) + 3,
    text: "XYZ\t",
  };

  return makeScenario("long line tab/offset/x cache", text, edit, LONG_LINE_ITERATIONS, {
    offsetProbe: edit.from + edit.text.length,
    xyProbe: { x: 60_000, y: 0 },
    viewport: { x1: 20_000, y1: 0, x2: 21_000, y2: metrics.lineHeight },
    range: { start: edit.from - 200, end: edit.from + 400 },
  });
};

const createMultiLineScenario = (): Scenario => {
  const text = createMultiLineText();
  const lineStride = MULTI_LINE_WIDTH + 1;
  const start = lineStride * 12_000 + 8;
  const end = start + lineStride * 4 + 12;
  const edit = {
    from: start,
    to: end,
    text: "replacement-a\nreplacement-b\tend\nreplacement-c",
  };

  return makeScenario("multi-line edit and query window", text, edit, MULTI_LINE_ITERATIONS, {
    offsetProbe: start + 20,
    xyProbe: { x: 96, y: 12_001 * metrics.lineHeight },
    viewport: {
      x1: 0,
      y1: 11_998 * metrics.lineHeight,
      x2: 640,
      y2: 12_008 * metrics.lineHeight,
    },
    range: { start: start - 100, end: start + 300 },
  });
};

const layoutChecksum = (layout: PosttextLayout, scenario: Scenario): number => {
  const xy = posttextOffsetToXY(layout, scenario.offsetProbe);
  const offset = posttextXYToOffset(layout, scenario.xyProbe);
  const viewport = queryNoWrapPosttextViewport(layout, scenario.viewport);
  const boxes = getPosttextRangeBoxes(layout, scenario.range.start, scenario.range.end);

  return (
    xy.x +
    xy.y +
    offset +
    viewport.lines.length * 17 +
    boxes.length * 31 +
    layout.width +
    layout.height
  );
};

const measureFresh = (scenario: Scenario): Measurement => {
  let checksum = 0;
  const start = performance.now();

  for (let iteration = 0; iteration < scenario.iterations; iteration += 1) {
    const layout = createNoWrapPosttextLayout(scenario.nextSnapshot, metrics);
    checksum += layoutChecksum(layout, scenario);
  }

  return {
    averageMs: (performance.now() - start) / scenario.iterations,
    checksum,
  };
};

const measureIncremental = (scenario: Scenario): Measurement => {
  let checksum = 0;
  const start = performance.now();

  for (let iteration = 0; iteration < scenario.iterations; iteration += 1) {
    const layout = applyNoWrapPosttextLayoutEdits(scenario.layout, scenario.nextSnapshot, [
      scenario.edit,
    ]);
    checksum += layoutChecksum(layout, scenario);
  }

  return {
    averageMs: (performance.now() - start) / scenario.iterations,
    checksum,
  };
};

const timingStats = (values: readonly number[]): TimingStats => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return {
    minMs: sorted[0] ?? 0,
    medianMs: sorted[middle] ?? 0,
  };
};

const assertChecksum = (scenario: Scenario, fresh: Measurement, incremental: Measurement): void => {
  if (fresh.checksum === incremental.checksum) return;
  throw new Error(`${scenario.label}: checksum drift`);
};

const profileFreshBuild = (
  scenario: Scenario,
): Pick<Sample, "buildLines" | "createRuns" | "buildTotal"> => {
  const buildLinesSamples: number[] = [];
  const createRunsSamples: number[] = [];
  const totalSamples: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const profile = profileNoWrapPosttextLayoutBuild(scenario.nextSnapshot, metrics);
    buildLinesSamples.push(profile.buildLinesMs);
    createRunsSamples.push(profile.createRunsMs);
    totalSamples.push(profile.totalMs);
  }

  return {
    buildLines: timingStats(buildLinesSamples),
    createRuns: timingStats(createRunsSamples),
    buildTotal: timingStats(totalSamples),
  };
};

const measureScenario = (scenario: Scenario): Sample => {
  assertChecksum(scenario, measureFresh(scenario), measureIncremental(scenario));

  const freshSamples: number[] = [];
  const incrementalSamples: number[] = [];
  let checksum = 0;

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const fresh = measureFresh(scenario);
    const incremental = measureIncremental(scenario);
    assertChecksum(scenario, fresh, incremental);
    freshSamples.push(fresh.averageMs);
    incrementalSamples.push(incremental.averageMs);
    checksum = incremental.checksum;
  }

  const fresh = timingStats(freshSamples);
  const incremental = timingStats(incrementalSamples);
  const profile = profileFreshBuild(scenario);

  return {
    label: scenario.label,
    iterations: scenario.iterations,
    samples: SAMPLE_COUNT,
    textLength: scenario.snapshot.length,
    lineCount: scenario.layout.lineIndex.lineCount,
    fresh,
    incremental,
    ...profile,
    medianSpeedup: fresh.medianMs / incremental.medianMs,
    minSpeedup: fresh.minMs / incremental.minMs,
    checksum,
  };
};

const printSample = (sample: Sample): void => {
  console.log(`posttext layout benchmark: ${sample.label}`);
  console.log(`samples: ${sample.samples} x ${sample.iterations} iterations`);
  console.log(`text length: ${sample.textLength.toLocaleString()}`);
  console.log(`logical lines: ${sample.lineCount.toLocaleString()}`);
  console.log(
    `fresh rebuild + queries: median ${formatMs(sample.fresh.medianMs)}, min ${formatMs(
      sample.fresh.minMs,
    )}`,
  );
  console.log(
    `incremental edit + queries: median ${formatMs(
      sample.incremental.medianMs,
    )}, min ${formatMs(sample.incremental.minMs)}`,
  );
  console.log(
    `fresh build profile: lines median ${formatMs(
      sample.buildLines.medianMs,
    )}, runs median ${formatMs(sample.createRuns.medianMs)}, total median ${formatMs(
      sample.buildTotal.medianMs,
    )}`,
  );
  console.log(`median speedup: ${sample.medianSpeedup.toFixed(2)}x`);
  console.log(`min speedup: ${sample.minSpeedup.toFixed(2)}x`);
  console.log(`checksum: ${sample.checksum.toFixed(0)}`);
  console.log("");
};

for (const scenario of [createLongLineScenario(), createMultiLineScenario()]) {
  printSample(measureScenario(scenario));
}
