import { expect, test } from "@playwright/test";

test("mounts the editor pane in the real app shell", async ({ page }) => {
  await page.goto("/");

  const editorPane = page.locator("#editor-container");
  await expect(editorPane).toBeVisible();
  await expect(editorPane).toHaveCSS("display", "flex");
});
