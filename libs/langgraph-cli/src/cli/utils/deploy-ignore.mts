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
  /**
   * Whether an otherwise-ignored directory must still be walked because a
   * negation (`!pattern`) could re-include one of its descendants.
   *
   * @remarks
   * This lets the archive walk prune ignored directories aggressively while
   * still descending into the (usually small) set of directories that a
   * negation reaches, instead of walking every ignored directory whenever any
   * negation exists. Ported from the Python CLI's
   * `_NegatedDockerignoreHints.requires_dir_walk`.
   *
   * @param relPath - Directory path relative to the spec's root, using `/`
   * separators and no trailing slash.
   * @returns `true` if the directory must be walked despite being ignored.
   */
  requiresDirWalk(relPath: string): boolean;
}

/** Characters that mark a path segment as a glob pattern. */
const GLOB_CHARS = ["*", "?", "["];

/** Whether `ancestor` is a strict path-prefix (ancestor) of `descendant`. */
function isAncestor(ancestor: string, descendant: string): boolean {
  return descendant.startsWith(`${ancestor}/`);
}

/**
 * Summary of which ignored directories a set of negation (`!pattern`) rules can
 * reach, so the archive walk only descends into directories that matter.
 *
 * Ported from the Python CLI's `_build_dockerignore_negation_hints` /
 * `_NegatedDockerignoreHints`.
 */
interface NegationHints {
  /** Whether a broad negation forces walking every ignored directory. */
  recurseAll: boolean;
  /** Concrete parent directories a literal negation must reach. */
  exactDirs: Set<string>;
  /** Literal prefixes preceding a glob in a negation pattern. */
  wildcardPrefixes: string[];
}

/**
 * Build {@link NegationHints} from raw ignore-file lines.
 *
 * @param lines - Raw lines from the loaded ignore files.
 * @returns The aggregated negation hints.
 */
function buildNegationHints(lines: string[]): NegationHints {
  const exactDirs = new Set<string>();
  const wildcardPrefixes = new Set<string>();
  let recurseAll = false;

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("\\!")) continue;
    if (line.startsWith("\\#")) line = line.slice(1);
    if (!line.startsWith("!")) continue;

    let pattern = line.slice(1).replace(/^\/+/, "");
    while (pattern.startsWith("./")) pattern = pattern.slice(2);
    pattern = pattern.replace(/\/+$/, "");
    const parts = pattern.split("/").filter((part) => part && part !== ".");
    if (!parts.length) {
      recurseAll = true;
      continue;
    }

    const wildcardIndex = parts.findIndex((part) =>
      GLOB_CHARS.some((char) => part.includes(char))
    );
    if (wildcardIndex !== -1) {
      const literalParts = parts.slice(0, wildcardIndex);
      if (!literalParts.length) {
        recurseAll = true;
        continue;
      }
      wildcardPrefixes.add(literalParts.join("/"));
      continue;
    }

    const parentParts = parts.slice(0, -1);
    for (let idx = 1; idx <= parentParts.length; idx += 1) {
      exactDirs.add(parentParts.slice(0, idx).join("/"));
    }
  }

  return { recurseAll, exactDirs, wildcardPrefixes: [...wildcardPrefixes] };
}

/**
 * Whether the directory at `relPath` must be walked given the negation hints.
 *
 * @param hints - The aggregated negation hints.
 * @param relPath - Directory path relative to the spec root (no trailing `/`).
 * @returns `true` if the directory must be walked despite being ignored.
 */
function requiresDirWalkWith(hints: NegationHints, relPath: string): boolean {
  if (hints.recurseAll || hints.exactDirs.has(relPath)) return true;
  return hints.wildcardPrefixes.some(
    (prefix) =>
      relPath === prefix ||
      isAncestor(relPath, prefix) ||
      isAncestor(prefix, relPath)
  );
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
  // Raw negation-bearing lines from the loaded ignore files (excluding the
  // built-in ALWAYS_EXCLUDE, which never contains negations) used to compute
  // which ignored directories must still be walked.
  const ignoreFileLines: string[] = [];
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
    ignoreFileLines.push(...fileLines);
    lines.push(...fileLines);
  }

  const ig: Ignore = ignore().add(lines);
  const negationHints = buildNegationHints(ignoreFileLines);

  return {
    ignores(relPath: string): boolean {
      // The `ignore` package rejects "." and absolute paths.
      if (!relPath || relPath === ".") return false;
      return ig.ignores(relPath);
    },
    hasNegation,
    requiresDirWalk(relPath: string): boolean {
      if (!relPath || relPath === ".") return true;
      return requiresDirWalkWith(negationHints, relPath);
    },
  };
}
