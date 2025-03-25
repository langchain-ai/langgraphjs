import { z } from "zod";
import { extendMeta, isZodDefault } from "./state.js";

const metaSymbol = Symbol.for("langgraph-zod");

interface ZodLangGraphTypes<T extends z.ZodTypeAny, Output> {
  reducer<Input>(
    transform: (a: Output, arg: Input) => Output,
    options: { schema: z.ZodType<Input>; default?: () => Output }
  ): z.ZodType<Output, z.ZodEffectsDef<T>, Input>;

  metadata(payload: {
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

if (!(metaSymbol in globalThis)) {
  (globalThis as Record<symbol, unknown>)[metaSymbol] = true;

  Object.defineProperty(
    z.ZodType.prototype,
    "langgraph" satisfies keyof z.ZodType,
    {
      get(): z.ZodType["langgraph"] {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const zodThis = this as z.ZodType<any, z.ZodEffectsDef<any>, any>;
        type Output = z.infer<typeof zodThis>;

        return {
          metadata(jsonSchemaExtra) {
            extendMeta(zodThis, (meta) => ({
              ...meta,
              jsonSchemaExtra,
            }));

            return zodThis;
          },
          reducer<Input>(
            transform: (a: Output, arg: Input) => Output,
            options: {
              schema: z.ZodType<Input>;
              default?: () => Output;
            }
          ) {
            const defaultFn: (() => Output) | undefined =
              options.default ??
              (isZodDefault(zodThis)
                ? // @ts-expect-error Due to any
                  zodThis._def.defaultValue
                : undefined);

            extendMeta(zodThis, (meta) => ({
              ...meta,
              default: defaultFn ?? meta?.default,
              reducer: { schema: options.schema, fn: transform },
            }));

            return zodThis;
          },
        };
      },
    }
  );
}
