import { renderDir, type FileSelectHandler } from "../tree.ts";
import { el } from "./dom.ts";

export type Sidebar = {
  readonly element: HTMLDivElement;
  clear(): void;
  renderDirectory(
    handle: FileSystemDirectoryHandle,
    onFileSelect: FileSelectHandler,
    options?: SidebarRenderOptions,
  ): Promise<void>;
};

export type SidebarRenderOptions = {
  readonly selectedPath?: string;
  readonly preserveExpandedPaths?: boolean;
};

export function createSidebar(): Sidebar {
  const element = el("div", { id: "tree" });
  const expandedDirectoryPaths = new Set<string>();

  return {
    element,
    clear: () => {
      expandedDirectoryPaths.clear();
      element.replaceChildren();
    },
    renderDirectory: async (handle, onFileSelect, options) => {
      const expandedPathsToRestore = options?.preserveExpandedPaths
        ? new Set(expandedDirectoryPaths)
        : new Set<string>();

      expandedDirectoryPaths.clear();
      element.replaceChildren();

      await renderDir(handle, element, onFileSelect, {
        selectedPath: options?.selectedPath,
        expandedPaths: expandedPathsToRestore,
        onDirectoryToggle: (directoryPath, open) => {
          setDirectoryOpen(expandedDirectoryPaths, directoryPath, open);
        },
      });
    },
  };
}

function setDirectoryOpen(
  expandedDirectoryPaths: Set<string>,
  directoryPath: string,
  open: boolean,
): void {
  if (open) {
    expandedDirectoryPaths.add(directoryPath);
    return;
  }

  expandedDirectoryPaths.delete(directoryPath);
  for (const path of expandedDirectoryPaths) {
    if (path.startsWith(directoryPath)) expandedDirectoryPaths.delete(path);
  }
}
