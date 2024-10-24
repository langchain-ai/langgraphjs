// This file is used by the CLI to dynamically execute tests against the user-provided checkpointer. It's written as a
// Jest test file because unfortunately there's no good way to just pass Jest a test definition function and tell it to
// run it.
import { specTest } from "./spec/index.js";
import { parseArgs } from "./parse_args.js";

const { initializer, filters } = await parseArgs(process.argv.slice(2));

if (!initializer) {
  throw new Error("Test configuration error: initializer is not set.");
}

specTest(initializer, filters);
