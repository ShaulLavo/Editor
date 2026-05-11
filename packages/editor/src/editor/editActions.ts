import type { DocumentSessionEditSelection } from "../documentSession";
import type { ResolvedSelection } from "../selections";
import type { TextEdit } from "../tokens";
import type { EditorCommandId } from "./commands";
import { nextWordOffset, previousWordOffset } from "./navigation";

export type EditorEditActionCommandId =
  | "deleteWordLeft"
  | "deleteWordRight"
  | "editor.action.deleteLines"
  | "editor.action.copyLinesUpAction"
  | "editor.action.copyLinesDownAction"
  | "editor.action.moveLinesUpAction"
  | "editor.action.moveLinesDownAction"
  | "editor.action.insertLineBefore"
  | "editor.action.insertLineAfter";

export type EditorEditActionResult = {
  readonly edits: readonly TextEdit[];
  readonly selections?: readonly DocumentSessionEditSelection[];
  readonly revealOffset?: number;
  readonly timingName: string;
};

type OffsetRange = {
  readonly start: number;
  readonly end: number;
};

type RowGroup = {
  readonly startRow: number;
  readonly endRow: number;
};

type LineMap = {
  readonly text: string;
  readonly starts: readonly number[];
};

type RelativePoint = {
  readonly row: number;
  readonly column: number;
};

type LineSelectionDescriptor = {
  readonly groupIndex: number;
  readonly anchor: RelativePoint;
  readonly head: RelativePoint;
};

export function isEditorEditActionCommand(
  command: EditorCommandId,
): command is EditorEditActionCommandId {
  return (
    command === "deleteWordLeft" ||
    command === "deleteWordRight" ||
    command === "editor.action.deleteLines" ||
    command === "editor.action.copyLinesUpAction" ||
    command === "editor.action.copyLinesDownAction" ||
    command === "editor.action.moveLinesUpAction" ||
    command === "editor.action.moveLinesDownAction" ||
    command === "editor.action.insertLineBefore" ||
    command === "editor.action.insertLineAfter"
  );
}

export function editActionForCommand(
  command: EditorEditActionCommandId,
  text: string,
  selections: readonly ResolvedSelection[],
): EditorEditActionResult {
  if (command === "deleteWordLeft") return deleteWordAction(text, selections, "left");
  if (command === "deleteWordRight") return deleteWordAction(text, selections, "right");
  if (command === "editor.action.deleteLines") return deleteLinesAction(text, selections);
  if (command === "editor.action.copyLinesUpAction") return copyLinesAction(text, selections, "up");
  if (command === "editor.action.copyLinesDownAction") {
    return copyLinesAction(text, selections, "down");
  }
  if (command === "editor.action.moveLinesUpAction") return moveLinesAction(text, selections, "up");
  if (command === "editor.action.moveLinesDownAction") {
    return moveLinesAction(text, selections, "down");
  }
  if (command === "editor.action.insertLineBefore") {
    return insertLineAction(text, selections, "before");
  }
  return insertLineAction(text, selections, "after");
}

function deleteWordAction(
  text: string,
  selections: readonly ResolvedSelection[],
  direction: "left" | "right",
): EditorEditActionResult {
  const ranges = selections
    .map((selection) => wordDeleteRange(text, selection, direction))
    .filter((range) => range.start !== range.end);
  const merged = mergeOffsetRanges(ranges);
  const edits = merged.map((range) => rangeToEdit(range, ""));
  const collapsedSelections = collapseSelectionsAfterRanges(merged);

  return {
    edits,
    selections: collapsedSelections,
    revealOffset: collapsedSelections[0]?.head,
    timingName: direction === "left" ? "input.deleteWordLeft" : "input.deleteWordRight",
  };
}

function deleteLinesAction(
  text: string,
  selections: readonly ResolvedSelection[],
): EditorEditActionResult {
  const map = createLineMap(text);
  const groups = rowGroupsForSelections(map, selections);
  const ranges = groups
    .map((group) => deleteRangeForGroup(map, group))
    .filter((range) => range.start !== range.end);
  const merged = mergeOffsetRanges(ranges);
  const edits = merged.map((range) => rangeToEdit(range, ""));
  const collapsedSelections = collapseSelectionsAfterRanges(merged);

  return {
    edits,
    selections: collapsedSelections,
    revealOffset: collapsedSelections[0]?.head,
    timingName: "input.deleteLines",
  };
}

function copyLinesAction(
  text: string,
  selections: readonly ResolvedSelection[],
  direction: "up" | "down",
): EditorEditActionResult {
  const map = createLineMap(text);
  const groups = rowGroupsForSelections(map, selections);
  const descriptors = lineSelectionDescriptors(map, selections, groups);
  const edits = groups.map((group) => copyLineEdit(map, group, direction));
  const targetRows = copyTargetRows(groups, direction);
  const nextText = applyTextEdits(text, edits);
  const nextMap = createLineMap(nextText);
  const nextSelections = selectionsForTargetRows(nextMap, descriptors, targetRows);

  return {
    edits,
    selections: nextSelections,
    revealOffset: nextSelections[0]?.head,
    timingName: direction === "up" ? "input.copyLinesUp" : "input.copyLinesDown",
  };
}

function moveLinesAction(
  text: string,
  selections: readonly ResolvedSelection[],
  direction: "up" | "down",
): EditorEditActionResult {
  const map = createLineMap(text);
  const groups = rowGroupsForSelections(map, selections);
  const descriptors = lineSelectionDescriptors(map, selections, groups);
  const movableGroups = groups.filter((group) => canMoveGroup(map, group, direction));
  const edits = movableGroups.map((group) => moveLineEdit(map, group, direction));
  const targetRows = groups.map((group) => moveTargetRow(map, group, direction));
  const nextText = applyTextEdits(text, edits);
  const nextMap = createLineMap(nextText);
  const nextSelections = selectionsForTargetRows(nextMap, descriptors, targetRows);

  return {
    edits,
    selections: nextSelections,
    revealOffset: nextSelections[0]?.head,
    timingName: direction === "up" ? "input.moveLinesUp" : "input.moveLinesDown",
  };
}

function insertLineAction(
  text: string,
  selections: readonly ResolvedSelection[],
  direction: "before" | "after",
): EditorEditActionResult {
  const map = createLineMap(text);
  const groups = rowGroupsForSelections(map, selections);
  const edits = groups.map((group) => insertLineEdit(map, group, direction));
  const nextText = applyTextEdits(text, edits);
  const nextMap = createLineMap(nextText);
  const nextSelections = insertedLineSelections(nextMap, groups, direction);

  return {
    edits,
    selections: nextSelections,
    revealOffset: nextSelections[0]?.head,
    timingName: direction === "before" ? "input.insertLineBefore" : "input.insertLineAfter",
  };
}

function wordDeleteRange(
  text: string,
  selection: ResolvedSelection,
  direction: "left" | "right",
): OffsetRange {
  if (!selection.collapsed) {
    return { start: selection.startOffset, end: selection.endOffset };
  }
  if (direction === "left") {
    return {
      start: previousWordOffset(text, selection.headOffset),
      end: selection.headOffset,
    };
  }

  return {
    start: selection.headOffset,
    end: nextWordOffset(text, selection.headOffset),
  };
}

function createLineMap(text: string): LineMap {
  const starts = [0];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    starts.push(index + 1);
  }

  return { text, starts };
}

function rowGroupsForSelections(
  map: LineMap,
  selections: readonly ResolvedSelection[],
): readonly RowGroup[] {
  return mergeRowGroups(selections.map((selection) => rowGroupForSelection(map, selection)));
}

function rowGroupForSelection(map: LineMap, selection: ResolvedSelection): RowGroup {
  const startRow = rowAtOffset(map, selection.startOffset);
  if (selection.collapsed) return { startRow, endRow: startRow };

  const endRow = endRowForSelection(map, selection, startRow);
  return { startRow, endRow };
}

function endRowForSelection(
  map: LineMap,
  selection: ResolvedSelection,
  startRow: number,
): number {
  const endRow = rowAtOffset(map, selection.endOffset);
  if (endRow <= startRow) return endRow;
  if (selection.endOffset !== lineStart(map, endRow)) return endRow;
  return endRow - 1;
}

function mergeRowGroups(groups: readonly RowGroup[]): readonly RowGroup[] {
  const sorted = groups.toSorted((left, right) => left.startRow - right.startRow);
  const merged: RowGroup[] = [];

  for (const group of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || group.startRow > previous.endRow + 1) {
      merged.push(group);
      continue;
    }

    merged[merged.length - 1] = {
      startRow: previous.startRow,
      endRow: Math.max(previous.endRow, group.endRow),
    };
  }

  return merged;
}

function deleteRangeForGroup(map: LineMap, group: RowGroup): OffsetRange {
  if (group.startRow === 0) return { start: 0, end: blockEnd(map, group) };
  if (group.endRow !== lastRow(map)) {
    return { start: blockStart(map, group), end: blockEnd(map, group) };
  }

  return {
    start: lineEnd(map, group.startRow - 1),
    end: map.text.length,
  };
}

function copyLineEdit(map: LineMap, group: RowGroup, direction: "up" | "down"): TextEdit {
  const atDocumentEnd = group.endRow === lastRow(map);
  if (direction === "up") {
    return {
      from: blockStart(map, group),
      to: blockStart(map, group),
      text: atDocumentEnd ? `${blockContentText(map, group)}\n` : blockText(map, group),
    };
  }

  return {
    from: blockEnd(map, group),
    to: blockEnd(map, group),
    text: atDocumentEnd ? `\n${blockContentText(map, group)}` : blockText(map, group),
  };
}

function copyTargetRows(groups: readonly RowGroup[], direction: "up" | "down"): readonly number[] {
  let insertedRowsBefore = 0;
  const targetRows: number[] = [];

  for (const group of groups) {
    const height = group.endRow - group.startRow + 1;
    targetRows.push(copyTargetRow(group, direction, insertedRowsBefore));
    insertedRowsBefore += height;
  }

  return targetRows;
}

function copyTargetRow(
  group: RowGroup,
  direction: "up" | "down",
  insertedRowsBefore: number,
): number {
  if (direction === "up") return group.startRow + insertedRowsBefore;
  return group.endRow + 1 + insertedRowsBefore;
}

function canMoveGroup(map: LineMap, group: RowGroup, direction: "up" | "down"): boolean {
  if (direction === "up") return group.startRow > 0;
  return group.endRow < lastRow(map);
}

function moveTargetRow(map: LineMap, group: RowGroup, direction: "up" | "down"): number {
  if (!canMoveGroup(map, group, direction)) return group.startRow;
  return group.startRow + (direction === "up" ? -1 : 1);
}

function moveLineEdit(map: LineMap, group: RowGroup, direction: "up" | "down"): TextEdit {
  if (direction === "up") return moveLineUpEdit(map, group);
  return moveLineDownEdit(map, group);
}

function moveLineUpEdit(map: LineMap, group: RowGroup): TextEdit {
  const previousRow = group.startRow - 1;
  return {
    from: lineStart(map, previousRow),
    to: blockEnd(map, group),
    text: moveUpReplacementText(map, group, previousRow),
  };
}

function moveLineDownEdit(map: LineMap, group: RowGroup): TextEdit {
  const nextRow = group.endRow + 1;
  return {
    from: blockStart(map, group),
    to: lineFullEnd(map, nextRow),
    text: moveDownReplacementText(map, group, nextRow),
  };
}

function moveUpReplacementText(map: LineMap, group: RowGroup, previousRow: number): string {
  if (group.endRow !== lastRow(map)) return `${blockText(map, group)}${lineText(map, previousRow)}`;
  return `${blockContentText(map, group)}\n${lineContentText(map, previousRow)}`;
}

function moveDownReplacementText(map: LineMap, group: RowGroup, nextRow: number): string {
  if (nextRow !== lastRow(map)) return `${lineText(map, nextRow)}${blockText(map, group)}`;
  return `${lineContentText(map, nextRow)}\n${blockContentText(map, group)}`;
}

function insertLineEdit(
  map: LineMap,
  group: RowGroup,
  direction: "before" | "after",
): TextEdit {
  const offset =
    direction === "before" ? lineStart(map, group.startRow) : lineEnd(map, group.endRow);
  return { from: offset, to: offset, text: "\n" };
}

function insertedLineSelections(
  map: LineMap,
  groups: readonly RowGroup[],
  direction: "before" | "after",
): readonly DocumentSessionEditSelection[] {
  let insertedRowsBefore = 0;
  const selections: DocumentSessionEditSelection[] = [];

  for (const group of groups) {
    const targetRow =
      direction === "before"
        ? group.startRow + insertedRowsBefore
        : group.endRow + 1 + insertedRowsBefore;
    const offset = lineStart(map, targetRow);
    selections.push({ anchor: offset, head: offset });
    insertedRowsBefore += 1;
  }

  return selections;
}

function lineSelectionDescriptors(
  map: LineMap,
  selections: readonly ResolvedSelection[],
  groups: readonly RowGroup[],
): readonly LineSelectionDescriptor[] {
  return selections
    .map((selection) => lineSelectionDescriptor(map, selection, groups))
    .filter((descriptor): descriptor is LineSelectionDescriptor => descriptor !== null);
}

function lineSelectionDescriptor(
  map: LineMap,
  selection: ResolvedSelection,
  groups: readonly RowGroup[],
): LineSelectionDescriptor | null {
  const groupIndex = groupIndexForSelection(map, selection, groups);
  const group = groups[groupIndex];
  if (!group) return null;

  return {
    groupIndex,
    anchor: relativePointForOffset(map, selection.anchorOffset, group.startRow),
    head: relativePointForOffset(map, selection.headOffset, group.startRow),
  };
}

function groupIndexForSelection(
  map: LineMap,
  selection: ResolvedSelection,
  groups: readonly RowGroup[],
): number {
  const selectionGroup = rowGroupForSelection(map, selection);
  return groups.findIndex(
    (group) => group.startRow <= selectionGroup.startRow && selectionGroup.endRow <= group.endRow,
  );
}

function selectionsForTargetRows(
  map: LineMap,
  descriptors: readonly LineSelectionDescriptor[],
  targetRows: readonly number[],
): readonly DocumentSessionEditSelection[] {
  return descriptors.map((descriptor) => {
    const targetStartRow = targetRows[descriptor.groupIndex] ?? 0;
    return {
      anchor: offsetForRelativePoint(map, targetStartRow, descriptor.anchor),
      head: offsetForRelativePoint(map, targetStartRow, descriptor.head),
    };
  });
}

function relativePointForOffset(map: LineMap, offset: number, startRow: number): RelativePoint {
  const row = rowAtOffset(map, offset);
  return {
    row: row - startRow,
    column: offset - lineStart(map, row),
  };
}

function offsetForRelativePoint(
  map: LineMap,
  targetStartRow: number,
  point: RelativePoint,
): number {
  const row = clamp(targetStartRow + point.row, 0, lastRow(map));
  return Math.min(lineStart(map, row) + point.column, lineEnd(map, row));
}

function collapseSelectionsAfterRanges(
  ranges: readonly OffsetRange[],
): readonly DocumentSessionEditSelection[] {
  let delta = 0;
  const selections: DocumentSessionEditSelection[] = [];

  for (const range of ranges) {
    const offset = range.start + delta;
    selections.push({ anchor: offset, head: offset });
    delta -= range.end - range.start;
  }

  return selections;
}

function mergeOffsetRanges(ranges: readonly OffsetRange[]): readonly OffsetRange[] {
  const sorted = ranges.toSorted((left, right) => left.start - right.start || left.end - right.end);
  const merged: OffsetRange[] = [];

  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end) {
      merged.push(range);
      continue;
    }

    merged[merged.length - 1] = {
      start: previous.start,
      end: Math.max(previous.end, range.end),
    };
  }

  return merged;
}

function rangeToEdit(range: OffsetRange, text: string): TextEdit {
  return { from: range.start, to: range.end, text };
}

function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  let next = text;
  const sorted = edits.toSorted((left, right) => right.from - left.from || right.to - left.to);

  for (const edit of sorted) {
    next = `${next.slice(0, edit.from)}${edit.text}${next.slice(edit.to)}`;
  }

  return next;
}

function rowAtOffset(map: LineMap, offset: number): number {
  const clamped = clamp(offset, 0, map.text.length);
  let row = 0;

  for (let index = 1; index < map.starts.length; index += 1) {
    const start = map.starts[index] ?? 0;
    if (start > clamped) break;
    row = index;
  }

  return row;
}

function lastRow(map: LineMap): number {
  return map.starts.length - 1;
}

function lineStart(map: LineMap, row: number): number {
  return map.starts[clamp(row, 0, lastRow(map))] ?? map.text.length;
}

function lineEnd(map: LineMap, row: number): number {
  if (row < lastRow(map)) return lineStart(map, row + 1) - 1;
  return map.text.length;
}

function lineFullEnd(map: LineMap, row: number): number {
  if (row < lastRow(map)) return lineStart(map, row + 1);
  return map.text.length;
}

function lineText(map: LineMap, row: number): string {
  return map.text.slice(lineStart(map, row), lineFullEnd(map, row));
}

function lineContentText(map: LineMap, row: number): string {
  return map.text.slice(lineStart(map, row), lineEnd(map, row));
}

function blockStart(map: LineMap, group: RowGroup): number {
  return lineStart(map, group.startRow);
}

function blockEnd(map: LineMap, group: RowGroup): number {
  return lineFullEnd(map, group.endRow);
}

function blockText(map: LineMap, group: RowGroup): string {
  return map.text.slice(blockStart(map, group), blockEnd(map, group));
}

function blockContentText(map: LineMap, group: RowGroup): string {
  return map.text.slice(blockStart(map, group), lineEnd(map, group.endRow));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
