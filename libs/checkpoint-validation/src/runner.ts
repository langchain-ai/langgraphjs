// This file is used by the CLI to dynamically execute tests against the user-provided checkpointer. It's written as a
// Vitest test file because unfortunately there's no good way to just pass Vitest a test definition function and tell it to
// run it.
import { inject } from "vitest";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { resolve as pathResolve } from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  checkpointerTestInitializerSchema,
  isTestTypeFilter,
  isTestTypeFilterArray,
  testTypeFilters,
  type CheckpointerTestInitializer,
} from "./types.js";
import { specTest } from "./spec/index.js";
import { findPackageRoot, resolveImportPath } from "./import_utils.js";

declare module "vitest" {
  interface ProvidedContext {
    LANGGRAPH_ARGS: { initializerImportPath: string; filters: string[] };
  }
}

export function isESM(path: string) {
  if (path.endsWith(".mjs") || path.endsWith(".mts")) {
    return true;
  }

  if (path.endsWith(".cjs") || path.endsWith(".cts")) {
    return false;
  }

  const packageJsonPath = pathResolve(findPackageRoot(path), "package.json");
  const packageConfig = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  return packageConfig.type === "module";
}

async function dynamicImport(modulePath: string) {
  if (isESM(modulePath)) return import(modulePath);
  const localRequire = createRequire(pathResolve(modulePath, "package.json"));
  return localRequire(modulePath);
}

const { initializerImportPath, filters } = inject("LANGGRAPH_ARGS");
const resolvedImportPath = resolveImportPath(initializerImportPath);

let initializerExport: unknown;
try {
  initializerExport = await dynamicImport(resolvedImportPath);
} catch (e) {
  console.error(
    `Failed to import initializer from import path '${initializerImportPath}' (resolved to '${resolvedImportPath}'): ${e}`
  );
  process.exit(1);
}

let initializer: CheckpointerTestInitializer<BaseCheckpointSaver>;
try {
  initializer = checkpointerTestInitializerSchema.parse(
    (initializerExport as { default?: unknown }).default ?? initializerExport
  ) as CheckpointerTestInitializer<BaseCheckpointSaver>;
} catch (e) {
  console.error(
    `Initializer imported from '${initializerImportPath}' does not conform to the expected schema. Make sure " +
      "it is the default export, and that implements the CheckpointSaverTestInitializer interface. Error: ${e}`
  );
  process.exit(1);
}

if (!isTestTypeFilterArray(filters)) {
  console.error(
    `Invalid filters: '${filters
      .filter((f) => !isTestTypeFilter(f))
      .join("', '")}'. Expected only values from '${testTypeFilters.join(
      "', '"
    )}'`
  );
  process.exit(1);
}

if (!initializer) {
  throw new Error("Test configuration error: initializer is not set.");
}

specTest(initializer, filters);
