import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const coreEntry = `/@fs/${fileURLToPath(
  new URL("../../../packages/editor/src/index.ts", import.meta.url),
)}`;

type TestWindow = Window & {
  __editor?: {
    getText(): string;
  };
  __editorInputEvents?: string[];
};

async function installInputEventProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const input = document.querySelector(".editor-virtualized-input");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("Missing editor input");

    (window as TestWindow).__editorInputEvents = [];
    input.addEventListener(
      "beforeinput",
      (event) => {
        const inputEvent = event as InputEvent;
        (window as TestWindow).__editorInputEvents?.push(
          `beforeinput:${inputEvent.inputType}:${inputEvent.data ?? ""}`,
        );
      },
      { capture: true },
    );
  });
}

test("routes real keyboard typing after clicking the editor surface", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async (entry) => {
    const { Editor } = await import(entry);
    const app = document.querySelector("#app");
    if (!app) throw new Error("Missing app root");

    app.innerHTML = '<div id="host" style="display:flex;height:300px;width:700px"></div>';
    const host = document.querySelector("#host");
    if (!(host instanceof HTMLElement)) throw new Error("Missing editor host");

    const editor = new Editor(host);
    editor.openDocument({ documentId: "note.txt", text: "abc" });
    (window as TestWindow).__editor = editor;
  }, coreEntry);
  await installInputEventProbe(page);

  await page.locator(".editor-virtualized").click({ position: { x: 80, y: 10 } });
  await expect(page.locator(".editor-virtualized-input")).toBeFocused();

  await page.keyboard.type("XYZ");

  await expect
    .poll(() => {
      return page.evaluate(() => (window as TestWindow).__editor?.getText());
    })
    .toBe("abcXYZ");
  await expect
    .poll(() => {
      return page.evaluate(() => (window as TestWindow).__editorInputEvents ?? []);
    })
    .toContain("beforeinput:insertText:X");
});

test("inserts repeated typing at a placed caret", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async (entry) => {
    const { Editor } = await import(entry);
    const app = document.querySelector("#app");
    if (!app) throw new Error("Missing app root");

    app.innerHTML = '<div id="host" style="display:flex;height:300px;width:700px"></div>';
    const host = document.querySelector("#host");
    if (!(host instanceof HTMLElement)) throw new Error("Missing editor host");

    const editor = new Editor(host);
    editor.openDocument({ documentId: "note.txt", text: "abcdef" });
    (window as TestWindow).__editor = editor;
  }, coreEntry);
  await installInputEventProbe(page);

  await page.locator(".editor-virtualized").click({ position: { x: 59, y: 10 } });
  await expect(page.locator(".editor-virtualized-input")).toBeFocused();

  await page.keyboard.type("XYZ");

  await expect
    .poll(() => {
      return page.evaluate(() => (window as TestWindow).__editor?.getText());
    })
    .toBe("abcXYZdef");
  await expect
    .poll(() => {
      return page.evaluate(() => (window as TestWindow).__editorInputEvents ?? []);
    })
    .toContain("beforeinput:insertText:X");
});

test("routes native line break input at a placed caret", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async (entry) => {
    const { Editor } = await import(entry);
    const app = document.querySelector("#app");
    if (!app) throw new Error("Missing app root");

    app.innerHTML = '<div id="host" style="display:flex;height:300px;width:700px"></div>';
    const host = document.querySelector("#host");
    if (!(host instanceof HTMLElement)) throw new Error("Missing editor host");

    const editor = new Editor(host);
    editor.openDocument({ documentId: "note.txt", text: "abcdef" });
    (window as TestWindow).__editor = editor;
  }, coreEntry);
  await installInputEventProbe(page);

  await page.locator(".editor-virtualized").click({ position: { x: 59, y: 10 } });
  await expect(page.locator(".editor-virtualized-input")).toBeFocused();

  await page.keyboard.press("Enter");

  await expect
    .poll(() => {
      return page.evaluate(() => (window as TestWindow).__editor?.getText());
    })
    .toBe("abc\ndef");
  await expect
    .poll(() => {
      return page.evaluate(() => (window as TestWindow).__editorInputEvents ?? []);
    })
    .toContain("beforeinput:insertLineBreak:");
});

test("focuses the editor for typing after selecting a file", async ({ page }) => {
  await page.addInitScript(() => {
    const fileHandle = {
      kind: "file",
      name: "note.txt",
      getFile: async () => new File(["abc"], "note.txt"),
    };
    const directoryHandle = {
      kind: "directory",
      name: "mock",
      entries: async function* () {
        yield ["note.txt", fileHandle] as const;
      },
    };

    window.showDirectoryPicker = async () => directoryHandle as FileSystemDirectoryHandle;
  });
  await page.goto("/");

  await page.locator("#open-btn").click();
  await page.locator(".entry.file").click();
  await expect(page.locator(".editor-virtualized-input")).toBeFocused();

  await page.keyboard.type("XYZ");

  await expect(page.locator(".editor-virtualized")).toContainText("abcXYZ");
});
