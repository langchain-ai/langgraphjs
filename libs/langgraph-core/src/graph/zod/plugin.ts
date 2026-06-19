import { z as z4 } from "zod/v4";
import { z as z3 } from "zod/v3";
import {
  getInteropZodDefaultGetter,
  InteropZodType,
} from "@langchain/core/utils/types";
import { SchemaMeta, withLangGraph } from "./meta.js";

const metaSymbol = Symbol.for("langgraph-zod");

interface ZodLangGraphTypesV3<T extends z3.ZodTypeAny, Output> {
  reducer<Input = z3.output<T>>(
    transform: (a: Output, arg: Input) => Output,
    options?: z3.ZodType<Input>
  ): z3.ZodType<Output, z3.ZodEffectsDef<T>, Input>;

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    langgraph: ZodLangGraphTypesV3<any, Output>;
  }
}
declare module "zod/v3" {
  interface ZodType<Output> {
    /**
     * @deprecated Using the langgraph zod plugin is deprecated and will be removed in future versions
     * Consider upgrading to zod 4 and using the exported langgraph meta registry. {@link langgraphRegistry}
     */
    langgraph: ZodLangGraphTypesV3<this, Output>;
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
  applyPluginPrototype(z4.ZodType.prototype);
} catch (error) {
  throw new Error(
    "Failed to extend Zod with LangGraph-related methods. This is most likely a bug, consider opening an issue and/or using `withLangGraph` to augment your Zod schema.",
    { cause: error }
  );
}
