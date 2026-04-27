import { describe, expect, it } from "vitest";

import { createEditorPane } from "../../src/components/editorPane.ts";

describe("createEditorPane", () => {
  it("creates an empty editor container", () => {
    const pane = createEditorPane();

    expect(pane.element).toBeInstanceOf(HTMLDivElement);
    expect(pane.element.id).toBe("editor-container");
    expect(pane.element.childElementCount).toBe(0);
  });
});
