import { describe, expect, it } from "vitest";

import {
  DEFAULT_MULTITASK_STRATEGY,
  normalizeMultitaskStrategy,
} from "../../src/protocol/service.mjs";

describe("normalizeMultitaskStrategy", () => {
  it("defaults to enqueue (matches the Python protocol-v2 server)", () => {
    expect(DEFAULT_MULTITASK_STRATEGY).toBe("enqueue");
  });

  it.each(["reject", "rollback", "interrupt", "enqueue"] as const)(
    "honors the recognized strategy %s",
    (strategy) => {
      expect(normalizeMultitaskStrategy(strategy)).toBe(strategy);
    }
  );

  it("returns undefined for omitted or unrecognized values", () => {
    // Caller falls back to DEFAULT_MULTITASK_STRATEGY for these.
    expect(normalizeMultitaskStrategy(undefined)).toBeUndefined();
    expect(normalizeMultitaskStrategy(null)).toBeUndefined();
    expect(normalizeMultitaskStrategy("bogus")).toBeUndefined();
    expect(normalizeMultitaskStrategy(123)).toBeUndefined();
  });
});
