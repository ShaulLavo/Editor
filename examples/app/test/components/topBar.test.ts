import { describe, expect, it } from "vitest";

import { createTopBar } from "../../src/components/topBar.ts";

describe("createTopBar", () => {
  it("tracks directory and busy state", () => {
    const topBar = createTopBar();

    topBar.setDirectoryName("workspace");
    expect(topBar.element.querySelector("#dir-name")?.textContent).toBe("workspace");

    topBar.setBusyState(false, true);
    expect(topBar.openButton.disabled).toBe(false);
    expect(topBar.refreshButton.disabled).toBe(false);

    topBar.setBusyState(true, true);
    expect(topBar.openButton.disabled).toBe(true);
    expect(topBar.refreshButton.disabled).toBe(true);

    topBar.setMessage("Failed");
    expect(topBar.element.querySelector("#dir-name")?.textContent).toBe("Failed");
  });
});
