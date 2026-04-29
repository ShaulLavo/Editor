export {
  createEditorSyntaxSession,
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
  TreeSitterLanguageRegistry,
  createTreeSitterLanguageRegistry,
  isTreeSitterLanguageId,
  resolveTreeSitterLanguageContribution,
  resolveTreeSitterLanguageAlias,
  type TreeSitterLanguageAssets,
  type TreeSitterLanguageContribution,
  type TreeSitterLanguageDescriptor,
  type TreeSitterLanguageDisposable,
  type TreeSitterLanguageId,
  type TreeSitterLanguageRegistrationOptions,
  type TreeSitterLanguageResolver,
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
