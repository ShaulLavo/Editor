import { Editor, type DocumentSessionChange } from "@editor/core";
import "@editor/core/style.css";
import { createEditorPane } from "./components/editorPane.ts";
import { el } from "./components/dom.ts";
import { createSidebar } from "./components/sidebar.ts";
import { createStatusBar } from "./components/statusBar.ts";
import { createTopBar } from "./components/topBar.ts";
import { getCachedHandle, cacheHandle } from "./db.ts";

const SELECTED_FILE_KEY = "editor-selected-file";

export function mountApp(): void {
  const app = document.getElementById("app")!;
  const topBar = createTopBar();
  const sidebar = createSidebar();
  const editorPane = createEditorPane();
  const statusBar = createStatusBar();
  const main = el("div", { id: "main" });
  main.append(sidebar.element, editorPane.element);

  app.append(topBar.element, main, statusBar.element);

  const editor = new Editor(editorPane.element, {
    onChange: (_state, change) => {
      updateStatus();
      if (change) reportTimings(change);
    },
  });
  let currentDirectoryHandle: FileSystemDirectoryHandle | null = null;
  let currentSelectedPath: string | undefined;
  let isRenderingDirectory = false;

  function updateToolbarState() {
    topBar.setBusyState(isRenderingDirectory, Boolean(currentDirectoryHandle));
  }

  function clearActiveFile() {
    currentSelectedPath = undefined;
    editor.clearDocument();
    updateStatus();
  }

  function updateStatus() {
    statusBar.update(currentSelectedPath, editor.getState());
  }

  function displayFile(filePath: string, content: string) {
    currentSelectedPath = filePath;
    localStorage.setItem(SELECTED_FILE_KEY, filePath);
    editor.openDocument({ documentId: filePath, text: content });
    updateStatus();
  }

  async function openDirectory(
    handle: FileSystemDirectoryHandle,
    options?: { selectedPath?: string; preserveExpandedPaths?: boolean },
  ) {
    currentDirectoryHandle = handle;
    currentSelectedPath = options?.selectedPath;
    isRenderingDirectory = true;
    updateToolbarState();
    topBar.setDirectoryName(handle.name);
    clearActiveFile();

    try {
      await sidebar.renderDirectory(handle, displayFile, {
        selectedPath: options?.selectedPath,
        preserveExpandedPaths: options?.preserveExpandedPaths,
      });
    } finally {
      isRenderingDirectory = false;
      updateToolbarState();
    }
  }

  async function refreshDirectory() {
    if (!currentDirectoryHandle) return;

    await openDirectory(currentDirectoryHandle, {
      selectedPath: currentSelectedPath,
      preserveExpandedPaths: true,
    });
  }

  getCachedHandle()
    .then(async (cached) => {
      if (!cached) return;
      const perm = await cached.queryPermission({ mode: "read" });
      if (perm === "granted") {
        const selectedPath = localStorage.getItem(SELECTED_FILE_KEY) ?? undefined;
        await openDirectory(cached, { selectedPath });
      }
    })
    .catch((err) => {
      console.error("Failed to restore cached directory:", err);
      topBar.setMessage("Failed to restore directory");
    });

  topBar.openButton.addEventListener("click", async () => {
    try {
      const handle = await window.showDirectoryPicker();
      await cacheHandle(handle);
      await openDirectory(handle);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return; // user cancelled the picker
      console.error("Failed to open directory:", err);
      topBar.setMessage("Failed to open directory");
    }
  });

  topBar.refreshButton.addEventListener("click", async () => {
    try {
      await refreshDirectory();
    } catch (err) {
      console.error("Failed to refresh directory:", err);
      topBar.setMessage("Failed to refresh directory");
    }
  });
}

function reportTimings(change: DocumentSessionChange): void {
  if (change.timings.length === 0) return;

  console.groupCollapsed(`[editor timings] ${change.kind}`);
  console.table(
    change.timings.map((timing) => ({
      phase: timing.name,
      durationMs: Number(timing.durationMs.toFixed(3)),
    })),
  );
  console.groupEnd();
}
