// This file is used by the CLI to dynamically execute tests against the user-provided checkpointer. It's written as a
// Jest test file because unfortunately there's no good way to just pass Jest a test definition function and tell it to
// run it.
import { specTest } from "./spec/index.js";
import { ParsedArgs, filtersSymbol, initializerSymbol } from "./parse_args.js";

// passing via global is ugly, but there's no good alternative for handling the dynamic import here
const initializer = (globalThis as typeof globalThis & ParsedArgs)[
  initializerSymbol
];

if (!initializer) {
  throw new Error("Test configuration error: initializer is not set.");
}

const filters = (globalThis as typeof globalThis & ParsedArgs)[filtersSymbol];

specTest(initializer, filters);
