import { expect, test } from "@playwright/test";

test("mounts the editor pane in the real app shell", async ({ page }) => {
  await page.goto("/");

  const editorPane = page.locator("#editor-container");
  await expect(editorPane).toBeVisible();
  await expect(editorPane).toHaveCSS("display", "flex");
});

test("loads Shiki token highlights for a source file", async ({ page }) => {
  const file = {
    path: "src/index.ts",
    text: "const answer: number = 42;\n",
  };
  await mockGitHubSource(page, file.path, file.text);
  await page.addInitScript((path) => {
    localStorage.clear();
    localStorage.setItem("editor-selected-file", path);
  }, file.path);

  await page.goto("/");

  await expect(page.locator(".editor-virtualized")).toContainText("const answer");
  await expect.poll(() => tokenHighlightRangeCount(page)).toBeGreaterThan(0);
});

async function tokenHighlightRangeCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const registry = (
      globalThis.CSS as
        | { highlights?: Iterable<[string, { readonly size: number }]> }
        | undefined
    )?.highlights;
    if (!registry) return 0;

    let count = 0;
    for (const [name, highlight] of registry) {
      if (!name.includes("-token-")) continue;
      count += highlight.size;
    }

    return count;
  });
}

async function mockGitHubSource(
  page: import("@playwright/test").Page,
  path: string,
  text: string,
): Promise<void> {
  await page.route(
    "https://api.github.com/repos/ShaulLavo/Editor/git/trees/main?recursive=1",
    (route) =>
      route.fulfill({
        json: {
          sha: "tree-sha",
          truncated: false,
          tree: [{ path, type: "blob", sha: "file-sha", size: text.length }],
        },
      }),
  );
  await page.route(`https://raw.githubusercontent.com/ShaulLavo/Editor/main/${path}`, (route) =>
    route.fulfill({
      body: text,
      contentType: "text/plain",
    }),
  );
}
