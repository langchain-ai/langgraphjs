import * as url from "node:url";
import * as path from "node:path";
import { startVitest } from "vitest/node";
import yargs from "yargs";
import {
  isTestTypeFilter,
  isTestTypeFilterArray,
  TestTypeFilter,
  testTypeFilters,
} from "./types.js";
import { resolveImportPath } from "./import_utils.js";

const builder = yargs()
  .command("* <initializer-import-path> [filters..]", "Validate a checkpointer")
  .positional("initializerImportPath", {
    type: "string",
    describe:
      "The import path of the CheckpointSaverTestInitializer for the checkpointer (passed to 'import()'). " +
      "Must be the default export.",
    demandOption: true,
  })
  .positional("filters", {
    array: true,
    choices: testTypeFilters,
    default: [] as TestTypeFilter[],
    describe: `Only run the specified suites. Valid values are ${testTypeFilters.join(
      ", "
    )}`,
    demandOption: false,
  })
  .help()
  .alias("h", "help")
  .wrap(yargs().terminalWidth())
  .strict();

export async function main() {
  const parsed = await builder.parse(process.argv.slice(2));

  try {
    resolveImportPath(parsed.initializerImportPath);
  } catch (e) {
    console.error(
      `Failed to resolve import path '${parsed.initializerImportPath}': ${e}`
    );
    process.exit(1);
  }

  if (!isTestTypeFilterArray(parsed.filters)) {
    console.error(
      `Invalid filters: '${(parsed.filters as TestTypeFilter[])
        .filter((f) => !isTestTypeFilter(f))
        .join("', '")}'. Expected only values from '${testTypeFilters.join(
        "', '"
      )}'`
    );
    process.exit(1);
  }

  const rootDir = path.resolve(
    path.dirname(url.fileURLToPath(import.meta.url)),
    "..",
    "dist"
  );
  const runner = path.resolve(rootDir, "runner.ts");

  await startVitest("test", [runner], {
    globals: true,
    include: [runner],
    exclude: [],
    provide: { LANGGRAPH_ARGS: parsed },
    dir: rootDir,
  });
}
