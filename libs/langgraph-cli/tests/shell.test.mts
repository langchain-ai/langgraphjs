import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecaOptions } from "../src/docker/shell.mjs";

const originalPath = process.env.PATH;
let testDirectory: string | undefined;

afterEach(async () => {
  process.env.PATH = originalPath;
  if (testDirectory) await rm(testDirectory, { recursive: true });
});

describe("getExecaOptions", () => {
  it("uses Docker from the current process PATH", async () => {
    testDirectory = await mkdtemp(join(tmpdir(), "langgraph-cli-"));
    const dockerPath = join(testDirectory, "docker");
    await writeFile(dockerPath, "#!/bin/sh\nexit 0\n");
    await chmod(dockerPath, 0o755);
    const path = `${testDirectory}:${originalPath}`;
    process.env.PATH = path;

    await expect(getExecaOptions()).resolves.toMatchObject({
      env: { PATH: path },
    });
  });
});
