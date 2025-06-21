import { z as zd } from "zod";
import { z as z3 } from "zod/v3";
import { getInteropZodDefaultGetter } from "@langchain/core/utils/types";
import { SchemaMeta, withLangGraph } from "./meta.js";

const metaSymbol = Symbol.for("langgraph-zod");

interface ZodLangGraphTypes<T extends zd.ZodTypeAny, Output> {
  reducer<Input = zd.output<T>>(
    transform: (a: Output, arg: Input) => Output,
    options?: zd.ZodType<Input>
  ): zd.ZodType<Output, zd.ZodEffectsDef<T>, Input>;

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

function applyPluginPrototype<
  PrototypeToExtend extends
    | typeof zd.ZodType.prototype
    | typeof z3.ZodType.prototype
>(prototype: PrototypeToExtend) {
  const cache = (globalThis as PluginGlobalType)[metaSymbol]!;
  if (cache.has(prototype)) {
    return; // Already applied
  }

  Object.defineProperty(
    prototype,
    "langgraph" satisfies keyof PrototypeToExtend,
    {
      get(): zd.ZodType["langgraph"] {
        // Return type is any, actual type provided by module augmentation
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const zodThis = this as zd.ZodTypeAny;
        type Output = zd.infer<typeof zodThis>;

        return {
          metadata(
            jsonSchemaExtra: SchemaMeta<Output, Output>["jsonSchemaExtra"]
          ) {
            return withLangGraph(zodThis, { jsonSchemaExtra });
          },
          reducer<Input>(
            fn: (a: Output, arg: Input) => Output,
            schema?: zd.ZodType<Input>
          ) {
            const defaultFn = getInteropZodDefaultGetter(zodThis);
            return withLangGraph(zodThis, {
              default: defaultFn,
              reducer: { schema, fn },
            });
          },
        };
      },
    }
  );
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
