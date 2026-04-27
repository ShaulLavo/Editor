import { describe, expect, it } from "vitest";

import { renderDir } from "../src/tree.ts";

describe("renderDir", () => {
  it("sorts directories before files and auto-selects the requested file", async () => {
    const container = document.createElement("div");
    const selectedFiles: Array<{ path: string; content: string }> = [];
    const root = directoryHandle("root", [
      fileHandle("zeta.ts", "z"),
      directoryHandle("src", [fileHandle("main.ts", "main")]),
      fileHandle("alpha.ts", "a"),
    ]);

    await renderDir(
      root,
      container,
      (path, content) => selectedFiles.push({ path, content }),
      { selectedPath: "alpha.ts" },
    );

    expect(entryLabels(container)).toEqual(["src", "alpha.ts", "zeta.ts"]);
    expect(selectedFiles).toEqual([{ path: "alpha.ts", content: "a" }]);
    expect(container.querySelector(".entry.active")?.textContent).toContain("alpha.ts");
  });

  it("restores expanded directories and reports toggles", async () => {
    const container = document.createElement("div");
    const toggles: Array<{ path: string; open: boolean }> = [];
    const root = directoryHandle("root", [
      directoryHandle("src", [fileHandle("main.ts", "main")]),
    ]);

    await renderDir(root, container, () => undefined, {
      expandedPaths: new Set(["src/"]),
      onDirectoryToggle: (path, open) => toggles.push({ path, open }),
    });

    expect(entryLabels(container)).toEqual(["src", "main.ts"]);
    expect(toggles).toEqual([{ path: "src/", open: true }]);

    clickEntry(container, "src");
    expect(toggles).toEqual([
      { path: "src/", open: true },
      { path: "src/", open: false },
    ]);
  });
});

function entryLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".entry")).map((entry) =>
    (entry.textContent ?? "").slice(3),
  );
}

function clickEntry(container: HTMLElement, name: string): void {
  const entry = Array.from(container.querySelectorAll(".entry")).find((candidate) =>
    candidate.textContent?.endsWith(name),
  );
  if (!(entry instanceof HTMLElement)) throw new Error(`Missing tree entry: ${name}`);
  entry.click();
}

function fileHandle(name: string, content: string): FileSystemFileHandle {
  return {
    kind: "file",
    name,
    getFile: async () => new File([content], name),
  } as FileSystemFileHandle;
}

function directoryHandle(
  name: string,
  children: Array<FileSystemFileHandle | FileSystemDirectoryHandle>,
): FileSystemDirectoryHandle {
  return {
    kind: "directory",
    name,
    entries: async function* () {
      for (const child of children) yield [child.name, child] as const;
    },
  } as FileSystemDirectoryHandle;
}
