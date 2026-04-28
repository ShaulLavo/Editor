export {
  createEditorSyntaxSession,
  inferEditorSyntaxLanguage,
  isEditorSyntaxLanguage,
  type EditorSyntaxLanguageId,
  type EditorSyntaxResult,
  type EditorSyntaxSession,
  type EditorSyntaxSessionOptions,
} from "./session";
export { styleForTreeSitterCapture, treeSitterCapturesToEditorTokens } from "./captures";
export {
  expandTreeSitterSelection,
  selectTreeSitterToken,
  shrinkTreeSitterSelection,
  type TreeSitterSelectionCommandOptions,
  type TreeSitterSelectionCommandResult,
  type TreeSitterSelectionExpansionState,
} from "./structuralSelection";
export {
  getTreeSitterLanguageDescriptor,
  inferTreeSitterLanguageFromFilename,
  isTreeSitterLanguageId,
  resolveTreeSitterLanguageAlias,
  TREE_SITTER_LANGUAGE_DESCRIPTORS,
  type TreeSitterLanguageDescriptor,
} from "./treeSitter/registry";
export type {
  BracketInfo,
  FoldRange,
  TreeSitterCapture,
  TreeSitterError,
  TreeSitterInjectionInfo,
  TreeSitterParseResult,
  TreeSitterPoint,
} from "./treeSitter/types";
