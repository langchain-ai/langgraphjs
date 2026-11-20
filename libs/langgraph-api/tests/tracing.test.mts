import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isTracingEnabled } from "../src/utils/tracing.mjs";

const tracingKeys = [
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING_V2",
  "LANGSMITH_TRACING",
  "LANGCHAIN_TRACING",
];

beforeEach(() => {
  for (const key of tracingKeys) vi.stubEnv(key, undefined);
});

afterEach(() => vi.unstubAllEnvs());

it.each(tracingKeys)("reads %s without a LangSmith SDK helper", (key) => {
  vi.stubEnv(key, "true");
  expect(isTracingEnabled()).toBe(true);
  vi.stubEnv(key, "false");
  expect(isTracingEnabled()).toBe(false);
});

it("defaults to disabled", () => {
  expect(isTracingEnabled()).toBe(false);
});

it("preserves the CLI tracing flag precedence", () => {
  vi.stubEnv("LANGSMITH_TRACING_V2", "false");
  vi.stubEnv("LANGCHAIN_TRACING", "true");
  expect(isTracingEnabled()).toBe(false);
});
