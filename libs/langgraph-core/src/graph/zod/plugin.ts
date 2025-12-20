import { z as zd } from "zod";
import { z as z3 } from "zod/v3";
import {
  getInteropZodDefaultGetter,
  InteropZodType,
} from "@langchain/core/utils/types";
import { SchemaMeta, withLangGraph } from "./meta.js";

const metaSymbol = Symbol.for("langgraph-zod");

interface ZodLangGraphTypes<T, Output> {
  // Overload 1: with explicit reducer schema - captures input type from the schema
  reducer<TReducerSchema extends { _output: unknown }>(
    transform: (a: Output, arg: TReducerSchema["_output"]) => Output,
    options: TReducerSchema
  ): T & { lg_reducer_schema: TReducerSchema };

  // Overload 2: without reducer schema - uses Output as input type
  reducer(
    transform: (a: Output, arg: Output) => Output
  ): T & { lg_reducer_schema: T };

  metadata(payload: {
    langgraph_nodes?: string[];
    langgraph_type?: "prompt";

    [key: string]: unknown;
  }): T;
}

declare module "zod" {
  interface ZodType<Output> {
    /**
     * @deprecated Using the langgraph zod plugin is deprecated and will be removed in future versions
     * Consider upgrading to zod 4 and using the exported langgraph meta registry. {@link langgraphRegistry}
     */
    langgraph: ZodLangGraphTypes<this, Output>;
  }
}

declare module "zod/v3" {
  interface ZodType<Output> {
    /**
     * @deprecated Using the langgraph zod plugin is deprecated and will be removed in future versions
     * Consider upgrading to zod 4 and using the exported langgraph meta registry. {@link langgraphRegistry}
     */
    langgraph: ZodLangGraphTypes<this, Output>;
  }
}

interface PluginGlobalType {
  [metaSymbol]?: WeakSet<object>;
}

if (!(metaSymbol in globalThis)) {
  (globalThis as PluginGlobalType)[metaSymbol] = new WeakSet();
}

function applyPluginPrototype(prototype: object) {
  const cache = (globalThis as PluginGlobalType)[metaSymbol]!;
  if (cache.has(prototype)) {
    return; // Already applied
  }

  Object.defineProperty(prototype, "langgraph", {
    get(this: InteropZodType) {
      // Actual return type is provided by module augmentation
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const zodThis = this;

      return {
        metadata(jsonSchemaExtra: SchemaMeta["jsonSchemaExtra"]) {
          return withLangGraph(zodThis, { jsonSchemaExtra });
        },
        reducer(
          fn: (a: unknown, arg: unknown) => unknown,
          schema?: InteropZodType
        ) {
          const defaultFn = getInteropZodDefaultGetter(zodThis);
          return withLangGraph(zodThis, {
            default: defaultFn,
            reducer: { schema, fn },
          });
        },
      };
    },
  });
  cache.add(prototype);
}

try {
  applyPluginPrototype(z3.ZodType.prototype);
  applyPluginPrototype(zd.ZodType.prototype);
} catch (error) {
  throw new Error(
    "Failed to extend Zod with LangGraph-related methods. This is most likely a bug, consider opening an issue and/or using `withLangGraph` to augment your Zod schema.",
    { cause: error }
  );
}
