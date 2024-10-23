import yargs from "yargs";
import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import {
  CheckpointerTestInitializer,
  checkpointerTestInitializerSchema,
  isTestTypeFilter,
  isTestTypeFilterArray,
  testTypeFilters,
} from "./types.js";
import { dynamicImport, resolveImportPath } from "./import_utils.js";

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
    choices: ["getTuple", "put", "putWrites", "list"],
    default: [],
    describe:
      "Only run the specified suites. Valid values are 'getTuple', 'put', 'putWrites', and 'list'",
    demandOption: false,
  })
  .help()
  .alias("h", "help")
  .wrap(yargs().terminalWidth())
  .strict();

export async function parseArgs<CheckpointerT extends BaseCheckpointSaver>(
  argv: string[]
) {
  const { initializerImportPath, filters } = await builder.parse(argv);

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

  let initializer: CheckpointerTestInitializer<CheckpointerT>;
  try {
    initializer = checkpointerTestInitializerSchema.parse(
      (initializerExport as { default?: unknown }).default ?? initializerExport
    ) as CheckpointerTestInitializer<CheckpointerT>;
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

  return {
    initializer,
    filters,
  };
}

export async function validateArgs(argv: string[]): Promise<void> {
  const { initializerImportPath, filters } = await builder.parse(argv);

  try {
    resolveImportPath(initializerImportPath);
  } catch (e) {
    console.error(
      `Failed to resolve import path '${initializerImportPath}': ${e}`
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
}
