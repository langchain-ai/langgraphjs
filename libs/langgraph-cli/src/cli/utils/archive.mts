/**
 * Create a tarball of project source for remote builds, ported from the
 * Python CLI's `archive.py`.
 *
 * The JS `assembleLocalDeps` requires every local dependency to live inside
 * the config directory, so (unlike the Python CLI) there are no external
 * build contexts to splice in: the archive root is always the config's parent
 * directory and the config path is included at its natural relative location.
 */

import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { create as tarCreate } from "tar";

import { ALWAYS_EXCLUDE_NAMES, buildIgnoreSpec } from "./deploy-ignore.mjs";

/** Number of bytes in one mebibyte, used for human-readable size output. */
const BYTES_PER_MIB = 1_048_576;
/** Archive size above which a warning is emitted (50 MB). */
const WARN_SIZE = 50 * 1024 * 1024;
/** Hard archive size limit enforced by the host backend (200 MB). */
const MAX_SIZE = 200 * 1024 * 1024;

/** A created source archive and the metadata needed to upload it. */
export interface Archive {
  /** Absolute path to the generated `source.tar.gz`. */
  archivePath: string;
  /** Size of the archive in bytes. */
  fileSize: number;
  /** Config path relative to the archive root (POSIX separators). */
  configRel: string;
  /** Remove the temporary directory holding the archive. */
  cleanup: () => Promise<void>;
}

/**
 * Recursively collect the POSIX-relative paths of every file under `rootDir`
 * that should be included in the archive.
 *
 * @remarks
 * Symlinks (and other non-regular entries) are skipped. Always-excluded
 * directories are pruned by name; other ignored directories are pruned too,
 * unless a negation (`!pattern`) could re-include one of their descendants (see
 * {@link IgnoreSpec.requiresDirWalk}), in which case the directory is still
 * walked and filtering happens per-file.
 *
 * @param rootDir - Absolute directory to walk (the archive root).
 * @returns Sorted-by-walk list of relative file paths to include.
 */
async function collectFiles(rootDir: string): Promise<string[]> {
  const spec = await buildIgnoreSpec(rootDir, { includeGitignore: true });
  const files: string[] = [];

  async function walk(dir: string, relPrefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);

      // Strip symlinks (and other non-regular entries) for safety, mirroring
      // the Python `_tar_filter`.
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (ALWAYS_EXCLUDE_NAMES.has(entry.name)) continue;
        const dirRel = `${rel}/`;
        // Prune ignored directories, but still descend into the (usually
        // small) set a negation could re-include from, instead of walking
        // every ignored directory whenever any negation exists.
        if (spec.ignores(dirRel) && !spec.requiresDirWalk(rel)) continue;
        await walk(abs, rel);
        continue;
      }

      if (!entry.isFile()) continue;
      if (spec.ignores(rel)) continue;
      files.push(rel);
    }
  }

  await walk(rootDir, "");
  return files;
}

/**
 * Create a `source.tar.gz` of the project rooted at the config's parent
 * directory.
 *
 * @remarks
 * Source files are filtered through {@link buildIgnoreSpec} (honoring
 * `.dockerignore` and `.gitignore`). The archive is validated to contain the
 * config file and checked against the size warning/limit thresholds. The
 * caller is responsible for invoking {@link Archive.cleanup} when done; on
 * failure the temp directory is cleaned up automatically.
 *
 * @param configPath - Path to `langgraph.json` (its parent is the archive root).
 * @param options - Behavior options.
 * @param options.onWarn - Invoked with a warning message when the archive
 * exceeds {@link WARN_SIZE} but is still under the hard limit.
 * @returns The created {@link Archive}.
 * @throws Error if the config file is missing from the archive or the archive
 * exceeds the 200 MB limit.
 */
export async function createArchive(
  configPath: string,
  options: { onWarn?: (message: string) => void } = {}
): Promise<Archive> {
  const resolvedConfig = path.resolve(configPath);
  const contextDir = path.dirname(resolvedConfig);
  const configRel = path
    .relative(contextDir, resolvedConfig)
    .split(path.sep)
    .join("/");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "langgraph-deploy-"));
  const archivePath = path.join(tmpDir, "source.tar.gz");
  const cleanup = async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  };

  try {
    const files = await collectFiles(contextDir);

    if (!files.includes(configRel)) {
      throw new Error(
        `Archive validation failed: ${configRel} not found in archive`
      );
    }

    await tarCreate(
      {
        gzip: true,
        file: archivePath,
        cwd: contextDir,
        portable: true,
        follow: false,
        noDirRecurse: true,
      },
      files
    );

    const { size: fileSize } = await fs.stat(archivePath);

    if (fileSize > MAX_SIZE) {
      throw new Error(
        `Source archive is ${(fileSize / BYTES_PER_MIB).toFixed(1)} MB, which ` +
          "exceeds the 200 MB limit. Add large files to .dockerignore or " +
          ".gitignore (model weights, data sets, etc.)."
      );
    }

    if (fileSize > WARN_SIZE && options.onWarn) {
      options.onWarn(
        `Warning: source archive is ${(fileSize / BYTES_PER_MIB).toFixed(1)} MB. ` +
          "Consider adding large files to .dockerignore or .gitignore."
      );
    }

    return { archivePath, fileSize, configRel, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export { BYTES_PER_MIB };
