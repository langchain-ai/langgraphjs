import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod/v4";
import { UntrackedValue } from "./untracked.js";
import { ReducedValue } from "./reduced.js";

describe("UntrackedValue", () => {
  describe("type inference", () => {
    it("should infer ValueType from schema", () => {
      const untracked = new UntrackedValue(z.string());
      expectTypeOf(untracked).toHaveProperty("ValueType");
      expectTypeOf<typeof untracked.ValueType>().toEqualTypeOf<string>();
    });

    it("should infer ValueType for complex schemas", () => {
      const untracked = new UntrackedValue(
        z.object({ name: z.string(), count: z.number() })
      );
      expectTypeOf<typeof untracked.ValueType>().toEqualTypeOf<{
        name: string;
        count: number;
      }>();
    });

    it("should infer ValueType with optional schema", () => {
      const untracked = new UntrackedValue(z.string().optional());
      expectTypeOf<typeof untracked.ValueType>().toEqualTypeOf<
        string | undefined
      >();
    });

    it("should default to unknown when no schema provided", () => {
      const untracked = new UntrackedValue();
      expectTypeOf<typeof untracked.ValueType>().toEqualTypeOf<unknown>();
    });
  });

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
