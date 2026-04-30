import { Editor } from "@editor/core/editor";
import "@editor/core/style.css";
import "@editor/minimap/style.css";
import { createFoldGutterPlugin, createLineGutterPlugin } from "@editor/gutters";
import { createMinimapPlugin } from "@editor/minimap";
import { css, html, javaScript, json, typeScript } from "@editor/tree-sitter-languages";
import { createEditorPane } from "./components/editorPane.ts";
import { el } from "./components/dom.ts";
import { createSidebar } from "./components/sidebar.ts";
import { createStatusBar } from "./components/statusBar.ts";
import { createTopBar } from "./components/topBar.ts";
import { createFoldChevronIcon } from "./foldGutterIcon.ts";
import { SourceController } from "./sourceController.ts";
import { createShikiHighlighterPlugin } from "@editor/shiki";

export function mountApp(): void {
  const app = document.getElementById("app")!;
  const topBar = createTopBar();
  const sidebar = createSidebar();
  const editorPane = createEditorPane();
  const statusBar = createStatusBar();
  const main = el("div", { id: "main" });
  main.append(sidebar.element, editorPane.element);

  app.append(topBar.element, main, statusBar.element);

  let controller: SourceController | null = null;
  const editor = new Editor(editorPane.element, {
    cursorLineHighlight: {
      gutterNumber: true,
      gutterBackground: ["fold-gutter"],
      rowBackground: true,
    },
    plugins: [
      javaScript({ jsx: true }),
      typeScript({ tsx: true }),
      html(),
      css(),
      json(),
      createLineGutterPlugin(),
      createFoldGutterPlugin({
        width: 16,
        icon: createFoldChevronIcon,
        iconClassName: "app-fold-gutter-icon",
      }),
      createShikiHighlighterPlugin({ theme: "github-dark" }),
      createMinimapPlugin(),
    ],
    onChange: (state) => {
      controller?.updateStatus(state);
    },
  });
  controller = new SourceController(topBar, sidebar, statusBar, editor);

  controller.start();
}
