interface TreeEntry {
  name: string;
  kind: "file" | "directory";
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
}

async function readDir(handle: FileSystemDirectoryHandle): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  for await (const [name, child] of handle.entries()) {
    entries.push({ name, kind: child.kind, handle: child });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

export async function renderDir(
  dirHandle: FileSystemDirectoryHandle,
  container: HTMLElement,
  onFileSelect: (content: string) => void,
) {
  const entries = await readDir(dirHandle);
  const ul = document.createElement("ul");

  for (const entry of entries) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "entry " + entry.kind;
    label.textContent = (entry.kind === "directory" ? "📁 " : "📄 ") + entry.name;

    if (entry.kind === "directory") {
      let loaded = false;
      let open = false;
      const childContainer = document.createElement("div");
      childContainer.style.display = "none";

      label.addEventListener("click", async () => {
        open = !open;
        if (!loaded) {
          await renderDir(entry.handle as FileSystemDirectoryHandle, childContainer, onFileSelect);
          loaded = true;
        }
        childContainer.style.display = open ? "" : "none";
        label.textContent = (open ? "📂 " : "📁 ") + entry.name;
      });

      li.appendChild(label);
      li.appendChild(childContainer);
    } else {
      label.addEventListener("click", async () => {
        document.querySelectorAll(".entry.active").forEach((el) => el.classList.remove("active"));
        label.classList.add("active");
        const file = await (entry.handle as FileSystemFileHandle).getFile();
        onFileSelect(await file.text());
      });
      li.appendChild(label);
    }
    ul.appendChild(li);
  }
  container.appendChild(ul);
}
