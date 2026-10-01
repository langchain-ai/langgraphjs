import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getDockerCapabilities } from "../src/docker/compose.mjs";
import { isBinaryNotFound } from "../src/docker/errors.mjs";

const DOCKER_INFO = JSON.stringify({
  ServerVersion: "26.1.1",
  ClientInfo: {
    Plugins: [
      { Name: "compose", Version: "v2.27.0" },
      { Name: "buildx", Version: "v0.14.0" },
    ],
  },
});

const originalPath = process.env.PATH;
const tempDirs: string[] = [];

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/** Put a stub `docker` on PATH and return the directory holding it. */
async function stubDockerOnPath(stdout: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lg-docker-"));
  tempDirs.push(dir);
  const bin = path.join(dir, "docker");
  await fs.writeFile(bin, `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\n`);
  await fs.chmod(bin, 0o755);
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
  return dir;
}

it("classifies a missing binary separately from a non-zero exit", () => {
  expect(isBinaryNotFound({ code: "ENOENT" })).toBe(true);
  expect(isBinaryNotFound({ code: "EACCES" })).toBe(false);
  expect(isBinaryNotFound({ exitCode: 1 })).toBe(false);
  expect(isBinaryNotFound(undefined)).toBe(false);
  expect(isBinaryNotFound(null)).toBe(false);
});

// The stub is a shell script, so this only applies to POSIX platforms. The
// behaviour under test — resolving `docker` from the inherited environment
// rather than a synthesised PATH — is platform independent.
it.skipIf(process.platform === "win32")(
  "resolves docker from the inherited PATH",
  async () => {
    await stubDockerOnPath(DOCKER_INFO);

    // Regression guard: this previously failed because the CLI replaced PATH
    // with a hardcoded list of macOS install locations, so a `docker` the
    // caller could run was invisible to it.
    await expect(getDockerCapabilities()).resolves.toMatchObject({
      composeType: "plugin",
      versionDocker: { major: 26, minor: 1, patch: 1 },
      versionCompose: { major: 2, minor: 27, patch: 0 },
      buildAvailable: true,
    });
  }
);

it.skipIf(process.platform === "win32")(
  "reports docker as not installed when it is absent from PATH",
  async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "lg-empty-"));
    tempDirs.push(empty);
    process.env.PATH = empty;

    await expect(getDockerCapabilities()).rejects.toThrow(
      /Docker is required but not installed/
    );
  }
);
