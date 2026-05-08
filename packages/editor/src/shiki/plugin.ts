import type { EditorHighlighterSessionOptions, EditorPlugin } from "../plugins";
import type { EditorSyntaxLanguageId } from "../syntax/session";
import {
  canUseShikiWorker,
  createShikiHighlighterSession,
  loadShikiTheme,
  type ShikiHighlighterSessionOptions,
} from "./workerClient";

export type ShikiLanguageMap = Partial<Record<EditorSyntaxLanguageId, string>>;

export type ShikiHighlighterPluginOptions = {
  readonly theme?: string;
  readonly languages?: ShikiLanguageMap;
  readonly preloadLanguages?: readonly string[];
  readonly preloadThemes?: readonly string[];
};

const DEFAULT_THEME = "github-dark";

const DEFAULT_LANGUAGE_MAP: ShikiLanguageMap = {
  css: "css",
  html: "html",
  javascriptreact: "jsx",
  javascript: "javascript",
  json: "json",
  tsx: "tsx",
  typescriptreact: "tsx",
  typescript: "typescript",
};

export function createShikiHighlighterPlugin(
  options: ShikiHighlighterPluginOptions = {},
): EditorPlugin {
  return {
    name: "shiki-highlighter",
    activate(context) {
      return context.registerHighlighter({
        loadTheme: () => loadConfiguredTheme(options),
        createSession: (sessionOptions) => createSession(sessionOptions, options),
      });
    },
  };
}

const createSession = (
  sessionOptions: EditorHighlighterSessionOptions,
  pluginOptions: ShikiHighlighterPluginOptions,
) => {
  if (!canUseShikiWorker()) return null;

  const lang = shikiLanguageForSession(sessionOptions, pluginOptions.languages);
  if (!lang) return null;

  return createShikiHighlighterSession({
    ...sessionOptions,
    lang,
    theme: pluginOptions.theme ?? DEFAULT_THEME,
    langs: preloadLanguages(lang, pluginOptions),
    themes: pluginOptions.preloadThemes,
  } satisfies ShikiHighlighterSessionOptions);
};

const loadConfiguredTheme = (options: ShikiHighlighterPluginOptions) =>
  loadShikiTheme({
    theme: options.theme ?? DEFAULT_THEME,
    themes: options.preloadThemes,
  });

const shikiLanguageForSession = (
  options: EditorHighlighterSessionOptions,
  languages: ShikiLanguageMap | undefined,
): string | null => {
  if (!options.languageId) return null;

  const configured = languages?.[options.languageId];
  if (configured) return configured;

  const extensionLang = shikiLanguageForDocumentExtension(options.documentId, options.languageId);
  return extensionLang ?? DEFAULT_LANGUAGE_MAP[options.languageId] ?? null;
};

const preloadLanguages = (
  lang: string,
  options: ShikiHighlighterPluginOptions,
): readonly string[] => [lang, ...Array.from(options.preloadLanguages ?? [])];

const shikiLanguageForDocumentExtension = (
  documentId: string,
  languageId: EditorSyntaxLanguageId,
): string | null => {
  const extension = extensionForDocumentId(documentId);
  if (languageId === "typescript" && extension === ".tsx") return "tsx";
  if (languageId === "javascript" && extension === ".jsx") return "jsx";
  return null;
};

const extensionForDocumentId = (documentId: string): string | null => {
  const path = documentId.split(/[?#]/, 1)[0] ?? documentId;
  const slashIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dotIndex = path.lastIndexOf(".");
  if (dotIndex <= slashIndex) return null;
  return path.slice(dotIndex).toLowerCase();
};
