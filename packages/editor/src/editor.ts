export { createMergeConflictPlugin, EDITOR_MERGE_CONFLICT_FEATURE_ID } from "./mergeConflictPlugin";
export {
  Editor,
  resetEditorInstanceCount,
  setEditorSyntaxSessionFactory,
  setHighlightRegistry,
} from "./editor/Editor";
export {
  createMergeConflictDocumentText,
  parseMergeConflicts,
  resolveMergeConflict,
} from "./mergeConflicts";
export type {
  EditorChangeHandler,
  EditorEditHistoryMode,
  EditorEditInput,
  EditorEditOptions,
  EditorEditSelection,
  EditorOpenDocumentOptions,
  EditorOptions,
  EditorScrollPosition,
  EditorSessionChangeHandler,
  EditorSessionOptions,
  EditorSetTextOptions,
  EditorState,
  EditorSyntaxSessionFactory,
  EditorSyntaxStatus,
  HighlightRegistry,
} from "./editor/types";
export type { EditorCommandContext, EditorCommandId } from "./editor/commands";
export type { EditorKeyBinding, EditorKeymapOptions } from "./editor/keymap";
export type {
  EditorMergeConflictFeature,
  EditorMergeConflictPluginOptions,
} from "./mergeConflictPlugin";
export type {
  CreateMergeConflictDocumentTextOptions,
  MergeConflictRegion,
  MergeConflictResolution,
  MergeConflictResolutionResult,
  MergeConflictSide,
  TextOffsetRange,
} from "./mergeConflicts";
export type {
  EditorCursorLineHighlightOptions,
  HiddenCharactersMode,
} from "./virtualization/virtualizedTextViewTypes";
export type { EditorSyntaxTheme, EditorSyntaxThemeColor, EditorTheme } from "./theme";
export type { EditorSyntaxProvider } from "./syntax";
export type {
  EditorDisposable,
  EditorGutterContribution,
  EditorGutterRowContext,
  EditorGutterWidthContext,
  EditorHighlightResult,
  EditorHighlighterProvider,
  EditorHighlighterSession,
  EditorHighlighterSessionOptions,
  EditorCommandHandler,
  EditorFeatureContribution,
  EditorFeatureContributionContext,
  EditorFeatureContributionProvider,
  EditorPlugin,
  EditorPluginContext,
  EditorResolvedSelection,
  EditorSelectionRange,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionProvider,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from "./plugins";
