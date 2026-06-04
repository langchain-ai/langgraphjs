/**
 * Test graph that throws an error during construction.
 * Used to test error propagation from JS to Python.
 */

export const graph = async () => {
  throw new Error("Graph construction failed intentionally for testing");
};
