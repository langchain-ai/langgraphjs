import {
  isAbsolute as pathIsAbsolute,
  resolve as pathResolve,
  dirname,
} from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

export function findPackageRoot(path: string): string {
  const packageJsonPath = pathResolve(path, "package.json");
  if (existsSync(packageJsonPath)) {
    return path;
  }

  if (pathResolve(dirname(path)) === pathResolve(path)) {
    throw new Error("Could not find package root");
  }

  return findPackageRoot(pathResolve(dirname(path)));
}

export function resolveImportPath(path: string) {
  // absolute path
  if (pathIsAbsolute(path)) {
    return path;
  }

  // relative path
  if (/^\.\.?(\/|\\)/.test(path)) {
    return pathResolve(path);
  } else {
    const resolvedPath = pathResolve(process.cwd(), path);
    // try it as a relative path, anyway
    if (existsSync(resolvedPath)) {
      return resolvedPath;
    }
  }

  // module name
  const packageRoot = findPackageRoot(process.cwd());
  if (packageRoot === undefined) {
    console.error(
      "Could not find package root to resolve initializer import path."
    );
    process.exit(1);
  }

  const localRequire = createRequire(pathResolve(packageRoot, "package.json"));
  return localRequire.resolve(path);
}
