import { beforeEach, describe, expect, it } from "vitest";

import { cacheHandle, clearCachedHandle, getCachedHandle } from "../src/db.ts";

describe("file system handle cache", () => {
  beforeEach(async () => {
    await clearCachedHandle();
  });

  it("stores, reads, and clears the cached directory handle", async () => {
    const handle = directoryHandle("workspace");

    await cacheHandle(handle);
    await expect(getCachedHandle()).resolves.toMatchObject({
      kind: "directory",
      name: "workspace",
    });

    await clearCachedHandle();
    await expect(getCachedHandle()).resolves.toBeNull();
  });
});

function directoryHandle(name: string): FileSystemDirectoryHandle {
  return {
    kind: "directory",
    name,
  } as FileSystemDirectoryHandle;
}
