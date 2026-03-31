import { Editor } from "@editor/core";
import "@editor/core/style.css";
import { getCachedHandle, cacheHandle } from "./db.ts";
import { renderDir } from "./tree.ts";

export function init() {
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div id="toolbar">
      <button id="open-btn">Open Directory</button>
      <span id="dir-name"></span>
    </div>
    <div id="main">
      <div id="tree"></div>
      <div id="editor-container"></div>
    </div>
  `;

  const openBtn = document.getElementById("open-btn") as HTMLButtonElement;
  const dirName = document.getElementById("dir-name") as HTMLSpanElement;
  const tree = document.getElementById("tree")!;
  const editorContainer = document.getElementById("editor-container")!;

  const editor = new Editor(editorContainer);

  async function open(handle: FileSystemDirectoryHandle) {
    dirName.textContent = handle.name;
    editor.clear();
    tree.innerHTML = "";
    await renderDir(handle, tree, (content) => editor.setContent(content));
  }

  getCachedHandle().then(async (cached) => {
    if (!cached) return;
    const perm = await cached.queryPermission({ mode: "read" });
    if (perm === "granted") await open(cached);
  });

  openBtn.addEventListener("click", async () => {
    try {
      const handle = await window.showDirectoryPicker();
      await cacheHandle(handle);
      await open(handle);
    } catch {
      // user cancelled
    }
  });
}
