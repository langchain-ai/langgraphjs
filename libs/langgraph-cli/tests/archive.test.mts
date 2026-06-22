import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { list as tarList } from "tar";

import { createArchive } from "../src/cli/utils/archive.mjs";
import { buildIgnoreSpec } from "../src/cli/utils/deploy-ignore.mjs";

let projectDir: string;

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "lg-archive-test-"));
});

afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true });
});

async function listEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tarList({
    file: archivePath,
    onentry: (entry) => entries.push(entry.path),
  });
  return entries;
}

describe("buildIgnoreSpec", () => {
  it("always excludes common directories", async () => {
    const spec = await buildIgnoreSpec(projectDir);
    expect(spec.ignores("node_modules/foo.js")).toBe(true);
    expect(spec.ignores(".git/config")).toBe(true);
    expect(spec.ignores("src/index.ts")).toBe(false);
  });

  it("honors .dockerignore and tracks negations", async () => {
    await fs.writeFile(
      path.join(projectDir, ".dockerignore"),
      "secrets/\n!keep.txt\n"
    );
    const spec = await buildIgnoreSpec(projectDir);
    expect(spec.ignores("secrets/key.pem")).toBe(true);
    expect(spec.hasNegation).toBe(true);
  });

  it("only walks ignored dirs a negation can reach (requiresDirWalk)", async () => {
    await fs.writeFile(
      path.join(projectDir, ".dockerignore"),
      ["build/", "!build/dist/app.js", "!cache/*/keep"].join("\n")
    );
    const spec = await buildIgnoreSpec(projectDir);
    // Literal negation reaches build/ and build/dist.
    expect(spec.requiresDirWalk("build")).toBe(true);
    expect(spec.requiresDirWalk("build/dist")).toBe(true);
    // Wildcard negation prefix `cache` and its descendants must be walked.
    expect(spec.requiresDirWalk("cache")).toBe(true);
    expect(spec.requiresDirWalk("cache/sub")).toBe(true);
    // Unrelated directories are not force-walked just because a negation
    // exists elsewhere.
    expect(spec.requiresDirWalk("node_modules")).toBe(false);
    expect(spec.requiresDirWalk("data")).toBe(false);
  });

  it("force-walks everything for a broad (root-glob) negation", async () => {
    await fs.writeFile(path.join(projectDir, ".dockerignore"), "*\n!*.log\n");
    const spec = await buildIgnoreSpec(projectDir);
    expect(spec.requiresDirWalk("anything")).toBe(true);
    expect(spec.requiresDirWalk("deeply/nested/dir")).toBe(true);
  });
});

describe("createArchive", () => {
  it("includes the config and source while excluding ignored files", async () => {
    await fs.writeFile(
      path.join(projectDir, "langgraph.json"),
      JSON.stringify({ graphs: { agent: "./agent.ts:graph" } })
    );
    await fs.writeFile(path.join(projectDir, "agent.ts"), "export const graph = 1;");
    await fs.writeFile(path.join(projectDir, ".gitignore"), "ignored.txt\n");
    await fs.writeFile(path.join(projectDir, "ignored.txt"), "secret");
    await fs.mkdir(path.join(projectDir, "node_modules", "pkg"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectDir, "node_modules", "pkg", "index.js"),
      "module.exports = {}"
    );

    const configPath = path.join(projectDir, "langgraph.json");
    const archive = await createArchive(configPath);
    try {
      expect(archive.configRel).toBe("langgraph.json");
      const entries = await listEntries(archive.archivePath);
      expect(entries).toContain("langgraph.json");
      expect(entries).toContain("agent.ts");
      expect(entries).not.toContain("ignored.txt");
      expect(entries.some((e) => e.startsWith("node_modules/"))).toBe(false);
    } finally {
      await archive.cleanup();
    }
  });
});
