import { z } from "zod";
import { extendMeta, isZodDefault, type Meta } from "./state.js";

const metaSymbol = Symbol.for("langgraph-zod");

interface ZodLangGraphTypes<T extends z.ZodTypeAny, Output> {
  reducer<Input = z.output<T>>(
    transform: (a: Output, arg: Input) => Output,
    options?: z.ZodType<Input>
  ): z.ZodType<Output, z.ZodEffectsDef<T>, Input>;

  metadata(payload: Record<string, unknown>): T;

  jsonSchemaExtra(payload: {
    langgraph_nodes?: string[];
    langgraph_type?: "prompt";

    [key: string]: unknown;
  }): T;
}

declare module "zod" {
  interface ZodType<Output> {
    langgraph: ZodLangGraphTypes<this, Output>;
  }
}

interface PluginGlobalType {
  [metaSymbol]?: WeakSet<typeof z.ZodType.prototype>;
}

if (!(metaSymbol in globalThis)) {
  (globalThis as PluginGlobalType)[metaSymbol] = new WeakSet();
}

try {
  const cache = (globalThis as PluginGlobalType)[metaSymbol];

  if (!cache?.has(z.ZodType.prototype)) {
    Object.defineProperty(
      z.ZodType.prototype,
      "langgraph" satisfies keyof z.ZodType,
      {
        get(): z.ZodType["langgraph"] {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const zodThis = this as z.ZodType<any, z.ZodEffectsDef<any>, any>;
          type Output = z.infer<typeof zodThis>;

          return {
            jsonSchemaExtra(
              jsonSchemaExtra: Meta<Output, Output>["jsonSchemaExtra"]
            ) {
              extendMeta(zodThis, (meta) => ({ ...meta, jsonSchemaExtra }));
              return zodThis;
            },

            metadata(metadata: Meta<Output, Output>["metadata"]) {
              extendMeta(zodThis, (meta) => ({ ...meta, metadata }));
              return zodThis;
            },

            reducer<Input>(
              fn: (a: Output, arg: Input) => Output,
              schema?: z.ZodType<Input>
            ) {
              const defaultFn = isZodDefault(zodThis)
                ? // @ts-expect-error Due to `_def` being `any`
                  zodThis._def.defaultValue
                : undefined;

              extendMeta<Output, Input>(zodThis, (meta) => ({
                ...meta,
                default: defaultFn ?? meta?.default,
                reducer: { schema, fn },
              }));

              return zodThis;
            },
          };
        },
      }
    );
  }
} catch (error) {
  throw new Error(
    "Failed to extend Zod with LangGraph-related methods. This is most likely a bug, consider opening an issue and/or using `withLangGraph` to augment your Zod schema.",
    { cause: error }
  );
}
