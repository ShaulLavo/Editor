import type { EditorState } from "@editor/core";
import { el } from "./dom.ts";

export type StatusBar = {
  readonly element: HTMLDivElement;
  clear(): void;
  update(filePath: string | undefined, state: EditorState): void;
};

export function createStatusBar(): StatusBar {
  const element = el("div", { id: "status" });
  const fileStatus = el("span", { id: "status-file" });
  const cursorStatus = el("span", { id: "status-cursor" });
  const lengthStatus = el("span", { id: "status-length" });
  const syntaxStatus = el("span", { id: "status-syntax" });
  const historyStatus = el("span", { id: "status-history" });
  element.append(fileStatus, cursorStatus, lengthStatus, syntaxStatus, historyStatus);

  const clear = () => {
    fileStatus.textContent = "No file";
    cursorStatus.textContent = "";
    lengthStatus.textContent = "";
    syntaxStatus.textContent = "";
    historyStatus.textContent = "";
  };

  return {
    element,
    clear,
    update: (filePath, state) => {
      if (!state.documentId) {
        clear();
        return;
      }

      fileStatus.textContent = filePath ?? "Untitled";
      cursorStatus.textContent = `Ln ${state.cursor.row + 1}, Col ${state.cursor.column + 1}`;
      lengthStatus.textContent = `${state.length} chars`;
      syntaxStatus.textContent = formatSyntaxStatus(state);
      historyStatus.textContent = `${state.canUndo ? "Undo" : "No undo"} / ${
        state.canRedo ? "Redo" : "No redo"
      }`;
    },
  };
}

function formatSyntaxStatus(state: EditorState): string {
  const language = state.languageId ?? "Plain text";
  if (state.syntaxStatus === "plain") return language;
  return `${language} ${state.syntaxStatus}`;
}
