// This file is used by the CLI to dynamically execute tests against the user-provided checkpoint saver. It's written
// as a Jest test file because unfortunately there's no good way to just pass Jest a test definition function and tell
// it to run it.
import { specTest } from "./spec/index.js";
import type { GlobalThis } from "./types.js";

// passing via global is ugly, but there's no good alternative for handling the dynamic import here
const initializer = (globalThis as GlobalThis)
  .__langgraph_checkpoint_validation_initializer;

if (!initializer) {
  throw new Error(
    "expected global '__langgraph_checkpoint_validation_initializer' is not set"
  );
}

const filters = (globalThis as GlobalThis)
  .__langgraph_checkpoint_validation_filters;

specTest(initializer, filters);
