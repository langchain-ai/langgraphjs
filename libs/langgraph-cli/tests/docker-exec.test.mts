import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getDockerCapabilities } from "../src/docker/compose.mjs";
import { activeDockerHost } from "../src/docker/docker.mjs";
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
const originalDockerHost = process.env.DOCKER_HOST;
const tempDirs: string[] = [];

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalDockerHost === undefined) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = originalDockerHost;
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

it.skipIf(process.platform === "win32")(
  "reads the daemon endpoint of the active docker context",
  async () => {
    delete process.env.DOCKER_HOST;
    await stubDockerOnPath("unix:///Users/dev/.docker/run/docker.sock");

    await expect(activeDockerHost()).resolves.toBe(
      "unix:///Users/dev/.docker/run/docker.sock"
    );
  }
);

it("leaves an explicit DOCKER_HOST to docker", async () => {
  process.env.DOCKER_HOST = "tcp://127.0.0.1:2375";

  await expect(activeDockerHost()).resolves.toBeUndefined();
});

it.skipIf(process.platform === "win32")(
  "keeps docker's default when the context can't be read",
  async () => {
    delete process.env.DOCKER_HOST;
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "lg-empty-"));
    tempDirs.push(empty);
    process.env.PATH = empty;

    await expect(activeDockerHost()).resolves.toBeUndefined();
  }
);
