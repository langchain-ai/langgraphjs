import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { UntrackedValue } from "./untracked.js";
import { ReducedValue } from "./reduced.js";

describe("UntrackedValue", () => {
  it("should create with default guard=true", () => {
    const untracked = new UntrackedValue(z.string());

    expect(UntrackedValue.isInstance(untracked)).toBe(true);
    expect(untracked.guard).toBe(true);
  });

  it("should allow guard=false", () => {
    const untracked = new UntrackedValue(z.string(), {
      guard: false,
    });

    expect(untracked.guard).toBe(false);
  });

  it("should store schema", () => {
    const schema = z.string();
    const untracked = new UntrackedValue(schema);

    expect(untracked.schema).toBe(schema);
  });

  describe("isInstance", () => {
    it("should identify UntrackedValue instances", () => {
      const untracked = new UntrackedValue(z.string());
      expect(UntrackedValue.isInstance(untracked)).toBe(true);
    });

    it("should reject non-UntrackedValue objects", () => {
      expect(UntrackedValue.isInstance({})).toBe(false);
      expect(UntrackedValue.isInstance(null)).toBe(false);
      expect(UntrackedValue.isInstance(undefined)).toBe(false);
      const reduced = new ReducedValue(z.number().default(0), {
        inputSchema: z.number(),
        reducer: (a, b) => a + b,
      });
      expect(UntrackedValue.isInstance(reduced)).toBe(false);
    });
  });
});
