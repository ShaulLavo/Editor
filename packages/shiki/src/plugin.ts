import type {
  EditorHighlighterSessionOptions,
  EditorPlugin,
  EditorSyntaxLanguageId,
} from "@editor/core";
import {
  canUseShikiWorker,
  createShikiHighlighterSession,
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

const DEFAULT_LANGUAGE_MAP = {
  css: "css",
  html: "html",
  javascript: "javascript",
  json: "json",
  tsx: "tsx",
  typescript: "typescript",
} satisfies Record<EditorSyntaxLanguageId, string>;

export function createShikiHighlighterPlugin(
  options: ShikiHighlighterPluginOptions = {},
): EditorPlugin {
  return {
    name: "shiki-highlighter",
    activate(context) {
      return context.registerHighlighter({
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

const shikiLanguageForSession = (
  options: EditorHighlighterSessionOptions,
  languages: ShikiLanguageMap | undefined,
): string | null => {
  if (!options.languageId) return null;

  const configured = languages?.[options.languageId];
  return configured ?? DEFAULT_LANGUAGE_MAP[options.languageId] ?? null;
};

const preloadLanguages = (
  lang: string,
  options: ShikiHighlighterPluginOptions,
): readonly string[] => [lang, ...Array.from(options.preloadLanguages ?? [])];
