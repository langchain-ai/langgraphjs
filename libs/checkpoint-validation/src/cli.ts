import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCLI } from "@jest/core";
import yargs, { ArgumentsCamelCase } from "yargs";
import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import {
  CheckpointerTestInitializer,
  checkpointerTestInitializerSchema,
  GlobalThis,
  TestTypeFilter,
} from "./types.js";
import { dynamicImport, resolveImportPath } from "./import_utils.js";

// make it so we can import/require .ts files
import "@swc-node/register/esm-register";

export async function main() {
  const moduleDirname = dirname(fileURLToPath(import.meta.url));

  const builder = yargs();
  await builder
    .command(
      "* <initializer-import-path> [filters..]",
      "Validate a checkpointer",
      {
        builder: (args) => {
          return args
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
            });
        },
        handler: async (
          argv: ArgumentsCamelCase<{
            initializerImportPath: string;
            filters: string[];
          }>
        ) => {
          const { initializerImportPath, filters } = argv;

          let resolvedImportPath;

          try {
            resolvedImportPath = resolveImportPath(initializerImportPath);
          } catch (e) {
            console.error(
              `Failed to resolve import path '${initializerImportPath}': ${e}`
            );
            process.exit(1);
          }

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
              (initializerExport as { default?: unknown }).default ??
                initializerExport
            );
            (
              globalThis as GlobalThis
            ).__langgraph_checkpoint_validation_initializer = initializer;
            (
              globalThis as GlobalThis
            ).__langgraph_checkpoint_validation_filters =
              filters as TestTypeFilter[];
          } catch (e) {
            console.error(
              `Initializer imported from '${initializerImportPath}' does not conform to the expected schema. Make sure " +
              "it is the default export, and that implements the CheckpointSaverTestInitializer interface. Error: ${e}`
            );
            process.exit(1);
          }

          await runCLI(
            {
              _: [],
              $0: "",
            },
            [pathResolve(moduleDirname, "..", "bin", "jest.config.cjs")]
          );
        },
      }
    )
    .help()
    .alias("h", "help")
    .wrap(builder.terminalWidth())
    .strict()
    .parseAsync(process.argv.slice(2));
}
