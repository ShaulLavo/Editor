import { describe, expect, it } from "vitest";

import "../src/style.css";

describe("find widget styles", () => {
  it("keeps the replace row hidden when collapsed", () => {
    const row = document.createElement("div");
    row.className = "editor-find-row editor-find-replace-row";
    row.hidden = true;
    document.body.appendChild(row);

    expect(getComputedStyle(row).display).toBe("none");

    row.hidden = false;
    expect(getComputedStyle(row).display).toBe("flex");
    row.remove();
  });
});
