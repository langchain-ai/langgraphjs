/**
 * Shared ignore-file handling for local source filtering, ported from the
 * Python CLI's `_ignore.py`. Combines a set of always-excluded directories
 * with patterns from `.dockerignore` (and optionally `.gitignore`), using
 * gitignore semantics via the `ignore` package.
 */

import ignore, { type Ignore } from "ignore";
import path from "node:path";
import { promises as fs } from "node:fs";

/** Directories always excluded from source filtering, regardless of config. */
const ALWAYS_EXCLUDE = [
  "__pycache__/",
  ".git/",
  ".venv/",
  "venv/",
  "node_modules/",
  ".tox/",
  ".mypy_cache/",
];

/**
 * Base names of the {@link ALWAYS_EXCLUDE} directories, used to prune the
 * filesystem walk before consulting the gitignore matcher.
 */
export const ALWAYS_EXCLUDE_NAMES = new Set(
  ALWAYS_EXCLUDE.map((pattern) => pattern.replace(/\/$/, "").split("/").pop()!)
);

/** A compiled set of ignore rules for filtering project source paths. */
export interface IgnoreSpec {
  /**
   * Whether the given POSIX-relative path is excluded.
   *
   * @param relPath - Path relative to the spec's root, using `/` separators.
   * @returns `true` if the path should be excluded.
   */
  ignores(relPath: string): boolean;
  /** Whether any negation (`!pattern`) was declared in the ignore files. */
  hasNegation: boolean;
}

/**
 * Read a text file split into lines, returning `null` if it does not exist or
 * is not a regular file.
 *
 * @param file - Absolute path to the file to read.
 * @returns The file's lines, or `null` when unreadable/missing.
 */
async function readLines(file: string): Promise<string[] | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    const content = await fs.readFile(file, "utf-8");
    return content.split(/\r?\n/);
  } catch {
    return null;
  }
}

/**
 * Build an {@link IgnoreSpec} for `directory`.
 *
 * @remarks
 * Always excludes the common non-source directories in {@link ALWAYS_EXCLUDE}.
 * On top of that, `.dockerignore` patterns are merged in, and `.gitignore`
 * patterns are added when `includeGitignore` is enabled (archive creation
 * wants both, while Docker build-context semantics want only `.dockerignore`).
 *
 * @param directory - Absolute directory whose ignore files are loaded.
 * @param options - Behavior options.
 * @param options.includeGitignore - Merge `.gitignore` patterns too (default
 * `true`).
 * @returns A spec exposing {@link IgnoreSpec.ignores} and `hasNegation`.
 */
export async function buildIgnoreSpec(
  directory: string,
  options: { includeGitignore?: boolean } = {}
): Promise<IgnoreSpec> {
  const includeGitignore = options.includeGitignore ?? true;
  const lines: string[] = [...ALWAYS_EXCLUDE];
  let hasNegation = false;

  const ignoreFiles = [".dockerignore"];
  if (includeGitignore) ignoreFiles.push(".gitignore");

  for (const name of ignoreFiles) {
    const fileLines = await readLines(path.join(directory, name));
    if (!fileLines) continue;
    for (const raw of fileLines) {
      const line = raw.trim();
      if (line && !line.startsWith("#") && line.startsWith("!")) {
        hasNegation = true;
      }
    }
    lines.push(...fileLines);
  }

  const ig: Ignore = ignore().add(lines);

  return {
    ignores(relPath: string): boolean {
      // The `ignore` package rejects "." and absolute paths.
      if (!relPath || relPath === ".") return false;
      return ig.ignores(relPath);
    },
    hasNegation,
  };
}
