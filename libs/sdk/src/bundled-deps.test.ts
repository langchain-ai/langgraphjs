import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(packageDir, "dist");
const bundledRoot = join(distDir, "node_modules");

function collectChunkDirs(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const found = entries.some((e) => e.isFile() && e.name.endsWith(".js"))
    ? [dir]
    : [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      found.push(...collectChunkDirs(join(dir, entry.name)));
    }
  }
  return found;
}

/**
 * Mirrors Node's package scope lookup: walk up from `dir` to the nearest
 * package.json, stopping at a node_modules segment. A `.js` chunk whose
 * lookup hits that boundary first has no scope and is parsed as CommonJS
 * on Node versions without module syntax detection.
 */
function scopeDeclaresModule(dir: string): boolean {
  let current = dir;
  for (;;) {
    if (basename(current) === "node_modules") return false;
    const pkgPath = join(current, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        type?: string;
      };
      return pkg.type === "module";
    }
    current = dirname(current);
  }
}

describe("bundled dependency chunks", () => {
  it("every directory with a .js chunk sits in a scope that declares ESM", () => {
    if (!existsSync(bundledRoot)) return;
    const undeclared = collectChunkDirs(bundledRoot).filter(
      (dir) => !scopeDeclaresModule(dir)
    );
    expect(undeclared).toEqual([]);
  });

  it("dist entry imports cleanly without module syntax detection", () => {
    const entry = pathToFileURL(join(distDir, "index.js")).href;
    const result = spawnSync(
      process.execPath,
      [
        "--no-experimental-detect-module",
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(entry)});`,
      ],
      {
        cwd: packageDir,
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, NODE_OPTIONS: "" },
      }
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
