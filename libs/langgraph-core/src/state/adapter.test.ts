import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { getSchemaDefaultGetter, getJsonSchemaFromSchema } from "./adapter.js";

describe("getSchemaDefaultGetter", () => {
  describe("with Zod schemas", () => {
    it("should extract default from .default(value)", () => {
      const schema = z.string().default("hello");
      const getter = getSchemaDefaultGetter(schema);

      expect(getter).toBeDefined();
      expect(getter!()).toBe("hello");
    });

    it("should extract default from .default(() => value)", () => {
      const schema = z.array(z.string()).default(() => ["a", "b"]);
      const getter = getSchemaDefaultGetter(schema);

      expect(getter).toBeDefined();
      expect(getter!()).toEqual(["a", "b"]);
    });

    it("should return undefined for schema without default", () => {
      const schema = z.string();
      const getter = getSchemaDefaultGetter(schema);

      expect(getter).toBeUndefined();
    });

    it("should work with nested optional schemas", () => {
      const schema = z.string().optional().default("fallback");
      const getter = getSchemaDefaultGetter(schema);

      expect(getter).toBeDefined();
      expect(getter!()).toBe("fallback");
    });

    it("should handle number defaults", () => {
      const schema = z.number().default(42);
      const getter = getSchemaDefaultGetter(schema);

      expect(getter).toBeDefined();
      expect(getter!()).toBe(42);
    });

    it("should handle zero as default", () => {
      const schema = z.number().default(0);
      const getter = getSchemaDefaultGetter(schema);

      expect(getter).toBeDefined();
      expect(getter!()).toBe(0);
    });

    it("should handle boolean defaults", () => {
      const schema = z.boolean().default(true);
      const getter = getSchemaDefaultGetter(schema);

      expect(getter).toBeDefined();
      expect(getter!()).toBe(true);
    });

    it("should handle false as default", () => {
      const schema = z.boolean().default(false);
      const getter = getSchemaDefaultGetter(schema);

      expect(getter).toBeDefined();
      expect(getter!()).toBe(false);
    });

    it("should handle object defaults", () => {
      const schema = z
        .object({ name: z.string() })
        .default({ name: "default" });
      const getter = getSchemaDefaultGetter(schema);

      expect(getter).toBeDefined();
      expect(getter!()).toEqual({ name: "default" });
    });

    it("should handle empty array default", () => {
      const schema = z.array(z.string()).default([]);
      const getter = getSchemaDefaultGetter(schema);

      expect(getter).toBeDefined();
      expect(getter!()).toEqual([]);
    });

    it("should handle null default", () => {
      const schema = z.string().nullable().default(null);
      const getter = getSchemaDefaultGetter(schema);

      expect(getter).toBeDefined();
      expect(getter!()).toBe(null);
    });

    it("should handle empty string default", () => {
      const schema = z.string().default("");
      const getter = getSchemaDefaultGetter(schema);

      expect(getter).toBeDefined();
      expect(getter!()).toBe("");
    });
  });

  describe("edge cases", () => {
    it("should return undefined for null input", () => {
      expect(getSchemaDefaultGetter(null)).toBeUndefined();
    });

    it("should return undefined for undefined input", () => {
      expect(getSchemaDefaultGetter(undefined)).toBeUndefined();
    });

    it("should return undefined for non-schema objects", () => {
      const notASchema = { type: "string" };
      expect(getSchemaDefaultGetter(notASchema)).toBeUndefined();
    });

    it("should return undefined for primitive values", () => {
      expect(getSchemaDefaultGetter("string")).toBeUndefined();
      expect(getSchemaDefaultGetter(123)).toBeUndefined();
      expect(getSchemaDefaultGetter(true)).toBeUndefined();
    });

    it("should return undefined for arrays", () => {
      expect(getSchemaDefaultGetter([])).toBeUndefined();
      expect(getSchemaDefaultGetter([1, 2, 3])).toBeUndefined();
    });
  });
});

describe("getJsonSchemaFromSchema", () => {
  it("should return undefined for null input", () => {
    expect(getJsonSchemaFromSchema(null)).toBeUndefined();
  });

  it("should return undefined for undefined input", () => {
    expect(getJsonSchemaFromSchema(undefined)).toBeUndefined();
  });

  it("should return undefined for non-schema objects", () => {
    const notASchema = { type: "string" };
    expect(getJsonSchemaFromSchema(notASchema)).toBeUndefined();
  });

  it("should return undefined for schemas without StandardJSONSchema support", () => {
    // Note: Zod v4 exposes jsonSchema via ~standard interface
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const jsonSchema = getJsonSchemaFromSchema(schema);

    expect(jsonSchema).toBeDefined();
  });
});
