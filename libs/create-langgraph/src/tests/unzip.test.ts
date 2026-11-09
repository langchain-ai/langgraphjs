import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";

import { extractZip } from "../index.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "create-langgraph-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// https://github.com/langchain-ai/langgraphjs/issues/2725
describe("extractZip", () => {
  it("extracts nested files and directories", async () => {
    const zip = zipSync({
      "repo-main/": {},
      "repo-main/src/index.ts": strToU8("export {};"),
      "repo-main/empty/": {},
    });

    await extractZip(zip, dir);

    await expect(
      fs.readFile(path.join(dir, "repo-main/src/index.ts"), "utf-8")
    ).resolves.toBe("export {};");
    expect((await fs.stat(path.join(dir, "repo-main/empty"))).isDirectory()).toBe(true);
  });

  it("rejects entries outside the destination", async () => {
    const dest = path.join(dir, "dest");
    const zip = zipSync({ "../evil.txt": strToU8("x") });

    await expect(extractZip(zip, dest)).rejects.toThrow(/Invalid zip entry/);
    await expect(fs.access(path.join(dir, "evil.txt"))).rejects.toThrow();
  });

  it("rejects invalid archives instead of hanging", async () => {
    await expect(extractZip(strToU8("not a zip"), dir)).rejects.toThrow();
  });
});
