import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import prettier from "prettier";
import type { PackageJson } from "type-fest";

import type { CompilePackageOptions } from "./types.js";

const execAsync = promisify(exec);

interface PNPMWorkspace {
  name: string;
  location: string;
}

export interface WorkspacePackage {
  pkg: PackageJson;
  path: string;
}

/**
 * Find all packages in the yarn workspace that match the package query and are not excluded.
 *
 * @param rootDir - The root directory of the workspace
 * @param opts - Options for filtering packages including packageQuery and exclude patterns
 * @returns A list of packages that match the query and are not excluded.
 */
export async function findWorkspacePackages(
  rootDir: string,
  opts: CompilePackageOptions
) {
  // Use pnpm to list workspaces in JSON format
  const result = await execAsync("pnpm m ls --json");
  // pnpm outputs a JSON array as one line
  let workspacesArray: PNPMWorkspace[];

  try {
    // pnpm's output is a single JSON blob or a single line array
    const parsed = JSON.parse(result.stdout);
    // pnpm may output { name, path, private, ... } for each workspace
    // Normalize to YarnWorkspace-like objects { name, location }
    workspacesArray = (Array.isArray(parsed) ? parsed : parsed.projects)
      .filter((entry: any) => entry.name && entry.path)
      .map((entry: any) => ({
        name: entry.name,
        location: entry.path, // pnpm gives absolute path OR relative path; resolve anyway below
      }));
  } catch (err) {
    console.error("Failed to parse pnpm workspaces list output:", err);
    return [];
  }

  const workspaces = (
    await Promise.all(
      workspacesArray.map(async (workspace: PNPMWorkspace) => {
        try {
          // PNPM's path may be absolute or relative; always resolve from rootDir
          // We skip the monorepo root if location is ".", similar to Yarn
          if (workspace.location === ".") {
            return null;
          }
          const workspacePath = resolve(rootDir, workspace.location);
          const pkgPath = resolve(workspacePath, "package.json");
          const pkg = JSON.parse(
            await readFile(pkgPath, "utf-8")
          ) as PackageJson;

          /**
           * skip package if it matches any exclude pattern
           */
          if (opts.exclude && opts.exclude.length > 0) {
            const isExcluded = opts.exclude.some(
              (excludePattern) => pkg.name === excludePattern
            );
            if (isExcluded) {
              return null;
            }
          }

          /**
           * compile package if no query is provided or the package name matches the query
           */
          if (
            !opts.packageQuery ||
            opts.packageQuery.length === 0 ||
            (pkg.name && opts.packageQuery.includes(pkg.name))
          ) {
            return {
              pkg,
              path: workspacePath,
            };
          }
        } catch (error) {
          console.error(
            `Error loading package.json for package: ${workspace.name}`,
            error
          );
          /* ignore */
          return null;
        }
      })
    )
  ).filter(Boolean) as WorkspacePackage[];
  return workspaces;
}

/**
 * Format TypeScript code using prettier with the project's configuration
 *
 * @param code - The TypeScript code to format
 * @param filePath - The file path for context (used to find prettier config)
 * @returns The formatted code
 */
export async function formatWithPrettier(
  code: string,
  filePath: string
): Promise<string> {
  try {
    // Get prettier config for the file
    const prettierConfig = await prettier.resolveConfig(filePath);

    // Format the code with TypeScript parser
    const formatted = await prettier.format(code, {
      ...prettierConfig,
      parser: "typescript",
    });

    return formatted;
  } catch (error) {
    console.warn("⚠️ Failed to format code with prettier:", error);
    // Return the original code if formatting fails
    return code;
  }
}
