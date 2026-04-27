import { describe, expect, it } from "vitest";

import { createSidebar } from "../../src/components/sidebar.ts";

describe("createSidebar", () => {
  it("renders a directory tree, selects files, and clears restored expansion state", async () => {
    const sidebar = createSidebar();
    const selectedFiles: Array<{ path: string; content: string }> = [];
    const root = directoryHandle("root", [
      directoryHandle("src", [fileHandle("main.ts", "console.log(1);")]),
      fileHandle("README.md", "# Project"),
    ]);

    await sidebar.renderDirectory(root, (path, content) => {
      selectedFiles.push({ path, content });
    });

    expect(entryLabels(sidebar.element)).toEqual(["src", "README.md"]);

    await clickEntry(sidebar.element, "src");
    await waitForEntry(sidebar.element, "main.ts");
    expect(entryLabels(sidebar.element)).toEqual(["src", "main.ts", "README.md"]);

    await clickEntry(sidebar.element, "main.ts");
    await waitForSelectedFile(selectedFiles);
    expect(selectedFiles).toEqual([{ path: "src/main.ts", content: "console.log(1);" }]);

    sidebar.clear();
    expect(sidebar.element.childElementCount).toBe(0);

    await sidebar.renderDirectory(root, () => undefined, { preserveExpandedPaths: true });
    expect(entryLabels(sidebar.element)).toEqual(["src", "README.md"]);
  });
});

function entryLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".entry")).map((entry) =>
    (entry.textContent ?? "").slice(3),
  );
}

async function clickEntry(container: HTMLElement, name: string): Promise<void> {
  const entry = Array.from(container.querySelectorAll(".entry")).find((candidate) =>
    candidate.textContent?.endsWith(name),
  );
  if (!(entry instanceof HTMLElement)) throw new Error(`Missing tree entry: ${name}`);
  entry.click();
}

async function waitForEntry(container: HTMLElement, name: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (entryLabels(container).includes(name)) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Timed out waiting for tree entry: ${name}`);
}

async function waitForSelectedFile(selectedFiles: readonly unknown[]): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (selectedFiles.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Timed out waiting for file selection");
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
