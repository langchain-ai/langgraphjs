import { describe, it, expect } from "vitest";
import { z } from "zod";
import { SchemaMetaRegistry, schemaMetaRegistry } from "./meta.js";

const SCHEMA_META_REGISTRY_KEY = Symbol.for(
  "@langchain/langgraph/schemaMetaRegistry"
);

describe("SchemaMetaRegistry", () => {
  describe("global singleton via Symbol.for()", () => {
    it("should store schemaMetaRegistry in globalThis", () => {
      const globalRegistry = (globalThis as Record<symbol, unknown>)[
        SCHEMA_META_REGISTRY_KEY
      ];
      expect(globalRegistry).toBe(schemaMetaRegistry);
    });

    it("should allow access to registered meta via globalThis lookup", () => {
      const schema = z.array(z.string());
      const reducer = {
        fn: (a: string[], b: string[]) => [...a, ...b],
        schema: z.array(z.string()),
      };
      schemaMetaRegistry.extend(schema, () => ({ reducer }));

      const globalRegistry = (globalThis as Record<symbol, unknown>)[
        SCHEMA_META_REGISTRY_KEY
      ] as SchemaMetaRegistry;
      const retrievedMeta = globalRegistry.get(schema);
      expect(retrievedMeta?.reducer?.fn).toBe(reducer.fn);
    });
  });

  describe("basic functionality", () => {
    it("should store and retrieve metadata for a schema", () => {
      const schema = z.object({ value: z.string() });
      const meta = { default: () => ({ value: "default" }) };

      schemaMetaRegistry.extend(schema, () => meta);

      expect(schemaMetaRegistry.get(schema)).toBe(meta);
      expect(schemaMetaRegistry.has(schema)).toBe(true);
    });

    it("should return undefined for unregistered schema", () => {
      const schema = z.object({ unregistered: z.boolean() });
      expect(schemaMetaRegistry.get(schema)).toBeUndefined();
      expect(schemaMetaRegistry.has(schema)).toBe(false);
    });

    it("should remove metadata from registry", () => {
      const schema = z.object({ toRemove: z.string() });
      schemaMetaRegistry.extend(schema, () => ({ default: () => ({}) }));
      expect(schemaMetaRegistry.has(schema)).toBe(true);

      schemaMetaRegistry.remove(schema);
      expect(schemaMetaRegistry.has(schema)).toBe(false);
    });
  });
});