import { el } from "./dom.ts";

export type EditorPane = {
  readonly element: HTMLDivElement;
};

export function createEditorPane(): EditorPane {
  return {
    element: el("div", { id: "editor-container" }),
  };
}
