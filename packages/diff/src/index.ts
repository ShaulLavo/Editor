export { DiffView } from "./DiffView";
export { createTextDiff, parseGitPatch } from "./model";
export { createSplitProjection, createStackedProjection } from "./projection";
export type {
  CreateTextDiffOptions,
  DiffFile,
  DiffFileChangeType,
  DiffHunkLocation,
  DiffHunkNavigationOptions,
  DiffHunk,
  DiffHunkLine,
  DiffInlineRange,
  DiffLineType,
  DiffRenderRow,
  DiffRenderRowType,
  DiffSplitHandleContext,
  DiffSplitPaneId,
  DiffSplitPaneLayout,
  DiffSplitPaneOptions,
  DiffSyntaxTokens,
  DiffTextFile,
  DiffViewMode,
  DiffViewOptions,
  ParseGitPatchOptions,
} from "./types";
