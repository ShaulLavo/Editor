export class LineStartOffsetIndex {
  private readonly tree: number[];
  private dirtyValue = false;

  public constructor(public readonly length: number) {
    this.tree = Array.from({ length: length + 1 }, () => 0);
  }

  public get dirty(): boolean {
    return this.dirtyValue;
  }

  public addSuffix(startRow: number, delta: number): void {
    if (delta === 0) return;
    const row = normalizeRow(startRow);
    if (row >= this.length) return;

    this.add(row + 1, delta);
    this.dirtyValue = true;
  }

  public offsetAt(row: number): number {
    const index = normalizeRow(row);
    if (index >= this.length) return 0;

    let sum = 0;
    for (let treeIndex = index + 1; treeIndex > 0; treeIndex -= treeIndex & -treeIndex) {
      sum += this.tree[treeIndex] ?? 0;
    }
    return sum;
  }

  public materialize(lineStarts: readonly number[]): number[] {
    if (!this.dirtyValue) return [...lineStarts];

    return lineStarts.map((start, row) => start + this.offsetAt(row));
  }

  private add(index: number, delta: number): void {
    for (let treeIndex = index; treeIndex < this.tree.length; treeIndex += treeIndex & -treeIndex) {
      this.tree[treeIndex] = (this.tree[treeIndex] ?? 0) + delta;
    }
  }
}

export function createLineStartOffsetIndex(lineCount: number): LineStartOffsetIndex {
  return new LineStartOffsetIndex(Math.max(0, Math.floor(lineCount)));
}

function normalizeRow(row: number): number {
  if (!Number.isFinite(row)) return 0;
  return Math.max(0, Math.floor(row));
}
