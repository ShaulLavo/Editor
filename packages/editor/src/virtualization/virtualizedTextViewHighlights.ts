import type { EditorToken, EditorTokenStyle } from "../tokens";
import {
  buildHighlightRule,
  clamp,
  normalizeTokenStyle,
  serializeTokenStyle,
} from "../style-utils";
import {
  addTokenRangeToChunk,
  appendTokenRange,
  appendTokenSegmentForChunk,
  editorTokensEqual,
  getOrCreateTokenSegments,
  setElementHidden,
  setStyleValue,
  tokenRowSignature,
  tokenStylesEqual,
} from "./virtualizedTextViewHelpers";
import { caretPosition, getMountedRows } from "./virtualizedTextViewRows";
import type {
  MountedVirtualizedTextRow,
  TokenGroup,
  TokenRowSegment,
  VirtualizedTextChunk,
  VirtualizedTextRow,
} from "./virtualizedTextViewTypes";
import type { TokenRenderEntry, VirtualizedTextViewInternal } from "./virtualizedTextViewInternals";

export function setTokens(view: VirtualizedTextViewInternal, tokens: readonly EditorToken[]): void {
  adoptTokens(view, [...tokens]);
}

export function adoptTokens(
  view: VirtualizedTextViewInternal,
  tokens: readonly EditorToken[],
): void {
  if (editorTokensEqual(view.tokens, tokens)) {
    view.tokens = tokens;
    view.tokenRangesFollowLastTextEdit = false;
    syncTokenGroupsToTokenSet(view);
    renderTokenHighlights(view);
    return;
  }

  if (canKeepLiveTokenRanges(view, tokens)) {
    view.tokens = tokens;
    view.tokenRangesFollowLastTextEdit = false;
    view.tokenRenderIndexDirty = true;
    syncTokenGroupsToTokenSet(view);
    return;
  }

  view.tokenRangesFollowLastTextEdit = false;
  view.tokens = tokens;
  view.tokenRenderIndexDirty = true;
  syncTokenGroupsToTokenSet(view);
  renderTokenHighlights(view);
}

export function setSelection(
  view: VirtualizedTextViewInternal,
  anchorOffset: number,
  headOffset: number,
): void {
  view.selectionStart = clamp(Math.min(anchorOffset, headOffset), 0, view.text.length);
  view.selectionEnd = clamp(
    Math.max(anchorOffset, headOffset),
    view.selectionStart,
    view.text.length,
  );
  renderSelectionHighlight(view);
}

export function clearSelection(view: VirtualizedTextViewInternal): void {
  view.selectionStart = null;
  view.selectionEnd = null;
  clearSelectionHighlight(view);
  renderCaret(view);
}

export function renderSelectionHighlight(view: VirtualizedTextViewInternal): void {
  const range = selectionRange(view);

  renderCaret(view);
  if (!range) {
    clearSelectionHighlight(view);
    return;
  }
  if (!view.selectionHighlight || !view.highlightRegistry) return;

  const signature = selectionHighlightSignature(view, range.start, range.end);
  if (signature === view.lastSelectionHighlightSignature) return;

  view.lastSelectionHighlightSignature = signature;
  clearSelectionHighlightRanges(view);
  addMountedSelectionRanges(view, range.start, range.end);
  if (view.selectionHighlight.size === 0) return;

  ensureSelectionHighlightRegistered(view);
}

function addMountedSelectionRanges(
  view: VirtualizedTextViewInternal,
  start: number,
  end: number,
): void {
  for (const row of getMountedRows(view)) {
    addMountedSelectionRange(view, row, start, end);
  }
}

function addMountedSelectionRange(
  view: VirtualizedTextViewInternal,
  row: VirtualizedTextRow,
  start: number,
  end: number,
): void {
  if (!view.selectionHighlight) return;
  if (end <= row.startOffset || start >= row.endOffset) return;

  for (const chunk of row.chunks) {
    addSelectionRangeToChunk(view, chunk, start, end);
  }
}

function addSelectionRangeToChunk(
  view: VirtualizedTextViewInternal,
  chunk: VirtualizedTextChunk,
  start: number,
  end: number,
): void {
  if (!view.selectionHighlight) return;
  if (end <= chunk.startOffset || start >= chunk.endOffset) return;

  const range = view.scrollElement.ownerDocument.createRange();
  range.setStart(chunk.textNode, clamp(start - chunk.startOffset, 0, chunk.textNode.length));
  range.setEnd(chunk.textNode, clamp(end - chunk.startOffset, 0, chunk.textNode.length));
  view.selectionHighlight.add(range);
}

export function clearSelectionHighlight(view: VirtualizedTextViewInternal): void {
  clearSelectionHighlightRanges(view);
  view.lastSelectionHighlightSignature = "";
  if (!view.selectionHighlightRegistered || !view.highlightRegistry) return;

  view.highlightRegistry.delete(view.selectionHighlightName);
  view.selectionHighlightRegistered = false;
}

function selectionHighlightSignature(
  view: VirtualizedTextViewInternal,
  start: number,
  end: number,
): string {
  const parts = [`${start}:${end}`];
  for (const row of getMountedRows(view)) {
    appendSelectionRowSignature(parts, row, start, end);
  }

  return parts.join("|");
}

function appendSelectionRowSignature(
  parts: string[],
  row: VirtualizedTextRow,
  start: number,
  end: number,
): void {
  if (end <= row.startOffset || start >= row.endOffset) return;

  for (const chunk of row.chunks) {
    const signature = selectionChunkSignature(row, chunk, start, end);
    if (signature) parts.push(signature);
  }
}

function renderCaret(view: VirtualizedTextViewInternal): void {
  if (view.selectionEnd === null || view.selectionStart !== view.selectionEnd) {
    setElementHidden(view.caretElement, true);
    return;
  }

  const position = caretPosition(view, view.selectionEnd);
  if (!position) {
    setElementHidden(view.caretElement, true);
    return;
  }

  setElementHidden(view.caretElement, false);
  setStyleValue(view.caretElement, "height", `${position.height}px`);
  setStyleValue(view.caretElement, "transform", `translate(${position.left}px, ${position.top}px)`);
}

export function clampStoredSelection(view: VirtualizedTextViewInternal): void {
  if (view.selectionStart === null || view.selectionEnd === null) return;

  view.selectionStart = clamp(view.selectionStart, 0, view.text.length);
  view.selectionEnd = clamp(view.selectionEnd, view.selectionStart, view.text.length);
}

export function renderTokenHighlights(view: VirtualizedTextViewInternal): void {
  if (!view.highlightRegistry || view.tokens.length === 0 || view.text.length === 0) {
    clearTokenHighlights(view);
    return;
  }

  const mountedRows = getMountedRows(view);
  const segmentsByRow = tokenSegmentsForRows(view, mountedRows);
  for (const row of mountedRows) {
    reconcileTokenHighlightsForRow(view, row, segmentsByRow.get(row.tokenHighlightSlotId) ?? []);
  }
}

function reconcileTokenHighlightsForRow(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  segments: readonly TokenRowSegment[],
): void {
  const signature = tokenRowSignature(row, segments);
  if (view.rowTokenSignatures.get(row.tokenHighlightSlotId) === signature) return;

  deleteTokenRangesForRow(view, row.tokenHighlightSlotId);
  addTokenSegmentsForRow(view, row, segments);
  view.rowTokenSignatures.set(row.tokenHighlightSlotId, signature);
}

function ensureTokenRenderIndex(view: VirtualizedTextViewInternal): void {
  if (!view.tokenRenderIndexDirty) return;

  rebuildTokenRenderIndex(view);
  view.tokenRenderIndexDirty = false;
}

function rebuildTokenRenderIndex(view: VirtualizedTextViewInternal): void {
  const entries: TokenRenderEntry[] = [];
  for (let index = 0; index < view.tokens.length; index += 1) {
    const token = view.tokens[index]!;
    const entry = tokenRenderEntry(view, token, index);
    if (!entry) continue;
    entries.push(entry);
  }

  entries.sort(compareTokenRenderEntries);
  view.tokenRenderEntries = entries;
  view.tokenRenderEntryMaxEnds = tokenRenderEntryMaxEnds(entries);
}

function tokenRenderEntry(
  view: VirtualizedTextViewInternal,
  token: EditorToken,
  sourceIndex: number,
): TokenRenderEntry | null {
  const style = normalizeTokenStyle(token.style);
  if (!style) return null;

  const start = clamp(token.start, 0, view.text.length);
  const end = clamp(token.end, start, view.text.length);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end <= start) return null;

  return {
    start,
    end,
    style,
    styleKey: serializeTokenStyle(style),
    sourceIndex,
  };
}

function firstTokenRenderEntryStartingAtOrAfter(
  view: VirtualizedTextViewInternal,
  offset: number,
): number {
  let low = 0;
  let high = view.tokenRenderEntries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const token = view.tokenRenderEntries[middle]!;
    if (token.start >= offset) {
      high = middle;
      continue;
    }

    low = middle + 1;
  }

  return low;
}

function firstTokenRenderEntryEndingAfter(
  view: VirtualizedTextViewInternal,
  offset: number,
  endIndex: number,
): number {
  let low = 0;
  let high = endIndex;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const maxEnd = view.tokenRenderEntryMaxEnds[middle] ?? 0;
    if (maxEnd > offset) {
      high = middle;
      continue;
    }

    low = middle + 1;
  }

  return low;
}

function tokenSegmentsForRows(
  view: VirtualizedTextViewInternal,
  rows: readonly MountedVirtualizedTextRow[],
): Map<number, TokenRowSegment[]> {
  const segmentsByRow = new Map<number, TokenRowSegment[]>();
  if (rows.length === 0) return segmentsByRow;

  ensureTokenRenderIndex(view);
  if (view.tokenRenderEntries.length === 0) return segmentsByRow;

  for (const row of rows) {
    appendTokenSegmentsForMountedRow(view, segmentsByRow, row);
  }

  return segmentsByRow;
}

function appendTokenSegmentsForMountedRow(
  view: VirtualizedTextViewInternal,
  segmentsByRow: Map<number, TokenRowSegment[]>,
  row: MountedVirtualizedTextRow,
): void {
  if (row.kind !== "text") return;

  for (const chunk of row.chunks) {
    appendTokenSegmentsForChunk(view, segmentsByRow, row, chunk);
  }
}

function appendTokenSegmentsForChunk(
  view: VirtualizedTextViewInternal,
  segmentsByRow: Map<number, TokenRowSegment[]>,
  row: MountedVirtualizedTextRow,
  chunk: VirtualizedTextChunk,
): void {
  if (chunk.endOffset <= chunk.startOffset) return;

  const endIndex = firstTokenRenderEntryStartingAtOrAfter(view, chunk.endOffset);
  const startIndex = firstTokenRenderEntryEndingAfter(view, chunk.startOffset, endIndex);
  if (startIndex >= endIndex) return;

  const segments = getOrCreateTokenSegments(segmentsByRow, row.tokenHighlightSlotId);
  for (let index = startIndex; index < endIndex; index += 1) {
    const token = view.tokenRenderEntries[index]!;
    if (token.end <= chunk.startOffset) continue;
    appendTokenSegmentForChunk(segments, chunk, token, token.style, token.styleKey);
  }
}

function addTokenSegmentsForRow(
  view: VirtualizedTextViewInternal,
  row: MountedVirtualizedTextRow,
  segments: readonly TokenRowSegment[],
): void {
  const rangesByStyle = new Map<string, AbstractRange[]>();
  const document = view.scrollElement.ownerDocument;
  for (const segment of segments) {
    const group = view.tokenGroups.get(segment.styleKey);
    if (!group) continue;

    const range = addTokenRangeToChunk(
      document,
      group.highlight,
      segment.chunk,
      segment.start,
      segment.end,
    );
    if (!range) continue;
    appendTokenRange(rangesByStyle, segment.styleKey, range);
  }

  if (rangesByStyle.size > 0) {
    view.rowTokenRanges.set(row.tokenHighlightSlotId, rangesByStyle);
  }
}

function ensureTokenGroup(
  view: VirtualizedTextViewInternal,
  styleKey: string,
  style: EditorTokenStyle,
): { readonly group: TokenGroup | null; readonly created: boolean } {
  const existing = view.tokenGroups.get(styleKey);
  if (existing) return { group: existing, created: false };

  const name = `${view.selectionHighlightName}-token-${view.nextTokenGroupId++}`;
  const highlight = new Highlight();
  if (!highlight) return { group: null, created: false };

  const group = {
    name,
    highlight,
    style,
    styleKey,
  };
  view.tokenGroups.set(styleKey, group);
  view.highlightRegistry?.set(name, group.highlight);
  return { group, created: true };
}

export function clearTokenHighlights(view: VirtualizedTextViewInternal): void {
  if (view.tokenGroups.size === 0 && view.rowTokenRanges.size === 0) return;

  for (const group of view.tokenGroups.values()) {
    view.highlightRegistry?.delete(group.name);
  }

  view.tokenGroups.clear();
  clearRowTokenState(view);
  view.nextTokenGroupId = 0;
  rebuildStyleRules(view);
}

function syncTokenGroupsToTokenSet(view: VirtualizedTextViewInternal): void {
  if (view.text.length === 0) {
    clearTokenHighlights(view);
    return;
  }

  const styles = currentTokenStyles(view);
  if (styles.size === 0) {
    clearTokenHighlights(view);
    return;
  }

  const added = ensureTokenGroupsForStyles(view, styles);
  const removed = removeUnusedTokenGroups(view, new Set(styles.keys()));
  if (added || removed) rebuildStyleRules(view);
}

function currentTokenStyles(view: VirtualizedTextViewInternal): Map<string, EditorTokenStyle> {
  ensureTokenRenderIndex(view);

  const styles = new Map<string, EditorTokenStyle>();
  for (const token of view.tokenRenderEntries) {
    styles.set(token.styleKey, token.style);
  }

  return styles;
}

function ensureTokenGroupsForStyles(
  view: VirtualizedTextViewInternal,
  styles: ReadonlyMap<string, EditorTokenStyle>,
): boolean {
  let added = false;
  for (const [styleKey, style] of styles) {
    const result = ensureTokenGroup(view, styleKey, style);
    added = added || result.created;
  }

  return added;
}

function removeUnusedTokenGroups(
  view: VirtualizedTextViewInternal,
  styleKeys: ReadonlySet<string>,
): boolean {
  let removed = false;
  for (const [key, group] of view.tokenGroups) {
    if (styleKeys.has(key)) continue;

    view.highlightRegistry?.delete(group.name);
    view.tokenGroups.delete(key);
    removed = true;
  }

  if (!removed) return false;

  clearRowTokenState(view);
  return true;
}

function canKeepLiveTokenRanges(
  view: VirtualizedTextViewInternal,
  tokens: readonly EditorToken[],
): boolean {
  if (!view.tokenRangesFollowLastTextEdit) return false;
  if (view.tokens.length !== tokens.length) return false;

  return view.tokens.every((token, index) => {
    const nextToken = tokens[index];
    return nextToken ? tokenStylesEqual(token, nextToken) : false;
  });
}

export function deleteTokenRangesForRow(
  view: VirtualizedTextViewInternal,
  rowSlotId: number,
): void {
  const rangesByStyle = view.rowTokenRanges.get(rowSlotId);
  if (!rangesByStyle) return;

  for (const [styleKey, capturedRanges] of rangesByStyle) {
    const group = view.tokenGroups.get(styleKey);
    if (!group) continue;

    for (const range of capturedRanges) {
      group.highlight.delete(range);
    }
  }

  view.rowTokenRanges.delete(rowSlotId);
}

export function clearRowTokenState(view: VirtualizedTextViewInternal): void {
  for (const rowSlotId of view.rowTokenRanges.keys()) {
    deleteTokenRangesForRow(view, rowSlotId);
  }

  view.rowTokenSignatures.clear();
  view.rowTokenRanges.clear();
}

function clearSelectionHighlightRanges(view: VirtualizedTextViewInternal): void {
  if (!view.selectionHighlight || view.selectionHighlight.size === 0) return;

  view.selectionHighlight?.clear();
}

function ensureSelectionHighlightRegistered(view: VirtualizedTextViewInternal): void {
  if (view.selectionHighlightRegistered) return;
  if (!view.selectionHighlight || !view.highlightRegistry) return;

  view.highlightRegistry.set(view.selectionHighlightName, view.selectionHighlight);
  view.selectionHighlightRegistered = true;
}

function selectionRange(
  view: VirtualizedTextViewInternal,
): { readonly start: number; readonly end: number } | null {
  if (view.selectionStart === null || view.selectionEnd === null) return null;
  if (view.selectionStart === view.selectionEnd) return null;

  return {
    start: view.selectionStart,
    end: view.selectionEnd,
  };
}

export function rebuildStyleRules(view: VirtualizedTextViewInternal): void {
  const rules = [
    `::highlight(${view.selectionHighlightName}) { background-color: rgba(56, 189, 248, 0.35); }`,
  ];
  for (const group of view.tokenGroups.values()) {
    rules.push(buildHighlightRule(group.name, group.style));
  }

  const nextRules = rules.join("\n");
  if (view.styleEl.textContent === nextRules) return;

  view.styleEl.textContent = nextRules;
}

function selectionChunkSignature(
  row: VirtualizedTextRow,
  chunk: VirtualizedTextChunk,
  start: number,
  end: number,
): string | null {
  if (end <= chunk.startOffset || start >= chunk.endOffset) return null;

  const localStart = clamp(start - chunk.startOffset, 0, chunk.textNode.length);
  const localEnd = clamp(end - chunk.startOffset, 0, chunk.textNode.length);
  return `${row.index}:${chunk.localStart}:${chunk.startOffset}:${localStart}:${localEnd}`;
}

function compareTokenRenderEntries(left: TokenRenderEntry, right: TokenRenderEntry): number {
  return left.start - right.start || left.sourceIndex - right.sourceIndex;
}

function tokenRenderEntryMaxEnds(entries: readonly TokenRenderEntry[]): number[] {
  const maxEnds: number[] = [];
  let maxEnd = 0;

  for (const entry of entries) {
    maxEnd = Math.max(maxEnd, entry.end);
    maxEnds.push(maxEnd);
  }

  return maxEnds;
}
