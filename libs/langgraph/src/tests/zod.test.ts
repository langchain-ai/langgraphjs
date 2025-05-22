import { z } from "zod";
import {
  isZodType,
  isZodDefault,
  isAnyZodObject,
  isZodObject,
  isZodObjectIntersection,
  withLangGraph,
  getMeta,
  extendMeta,
  getChannelsFromZod,
  type Meta,
} from "../graph/zod/state.js";
import { BinaryOperatorAggregate } from "../channels/binop.js";
import { LastValue } from "../channels/last_value.js";

describe("Zod State Functions", () => {
  describe("Type Checking Functions", () => {
    test("isZodType", () => {
      expect(isZodType(z.string())).toBe(true);
      expect(isZodType(z.number())).toBe(true);
      expect(isZodType({})).toBe(false);
      expect(isZodType(null)).toBe(false);
      expect(isZodType(undefined)).toBe(false);
    });

    test("isZodDefault", () => {
      expect(isZodDefault(z.string().default("test"))).toBe(true);
      expect(isZodDefault(z.string())).toBe(false);
      expect(isZodDefault({})).toBe(false);
    });

    test("isZodObject", () => {
      const schema = z.object({ name: z.string() });
      expect(isZodObject(schema)).toBe(true);
      expect(isZodObject(z.string())).toBe(false);
      expect(isZodObject({})).toBe(false);
    });

    test("isZodObjectIntersection", () => {
      const schema1 = z.object({ name: z.string() });
      const schema2 = z.object({ age: z.number() });
      const intersection = schema1.and(schema2);

      expect(isZodObjectIntersection(intersection)).toBe(true);
      expect(isZodObjectIntersection(schema1)).toBe(false);
      expect(isZodObjectIntersection({})).toBe(false);
    });

    test("isAnyZodObject", () => {
      const schema = z.object({ name: z.string() });
      const schema1 = z.object({ name: z.string() });
      const schema2 = z.object({ age: z.number() });
      const intersection = schema1.and(schema2);

      expect(isAnyZodObject(schema)).toBe(true);
      expect(isAnyZodObject(intersection)).toBe(true);
      expect(isAnyZodObject(z.string())).toBe(false);
      expect(isAnyZodObject({})).toBe(false);
    });
  });

  describe("Meta Functions", () => {
    test("withLangGraph and getMeta", () => {
      const schema = z.string();
      const meta: Meta<string> = {
        jsonSchemaExtra: {
          langgraph_type: "prompt",
        },
        reducer: {
          fn: (a: string, b: string) => a + b,
        },
        default: () => "default",
      };

      const enhancedSchema = withLangGraph(schema, meta);
      const retrievedMeta = getMeta(enhancedSchema);

      expect(retrievedMeta).toEqual(meta);
    });

    test("extendMeta", () => {
      const schema = z.string();
      const initialMeta: Meta<string> = {
        jsonSchemaExtra: {
          langgraph_type: "prompt",
        },
      };

      withLangGraph(schema, initialMeta);

      extendMeta(schema, (existingMeta: Meta<string> | undefined) => ({
        ...existingMeta,
        reducer: {
          fn: (a: string, b: string) => a + b,
        },
        default: () => "default",
      }));

      const updatedMeta = getMeta(schema);
      expect(updatedMeta?.reducer).toBeDefined();
      expect(updatedMeta?.default).toBeDefined();
    });
  });

  describe("getChannelsFromZod", () => {
    test("simple object schema", () => {
      const schema = z.object({
        name: z.string(),
        count: z.number().default(0),
      });

      const channels = getChannelsFromZod(schema);
      expect(channels.name).toBeInstanceOf(LastValue);
      expect(channels.count).toBeInstanceOf(LastValue);
    });

    test("schema with reducer", () => {
      const schema = z.object({
        messages: withLangGraph(z.array(z.string()), {
          reducer: {
            fn: (a: string[], b: string[]) => [...a, ...b],
            schema: z.array(z.string()),
          },
          default: () => [],
        }),
      });

      const channels = getChannelsFromZod(schema);
      expect(channels.messages).toBeInstanceOf(BinaryOperatorAggregate);
    });

    test("intersection schema", () => {
      const schema1 = z.object({ name: z.string() });
      const schema2 = z.object({ age: z.number() });
      const intersection = schema1.and(schema2);

      const channels = getChannelsFromZod(intersection);
      expect(channels.name).toBeInstanceOf(LastValue);
      expect(channels.age).toBeInstanceOf(LastValue);
    });
  });
});
