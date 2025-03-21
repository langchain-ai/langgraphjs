import z from "zod";

import { RunnableLike } from "@langchain/core/runnables";
import { BinaryOperator, BinaryOperatorAggregate } from "../channels/binop.js";
import { LastValue } from "../channels/last_value.js";
import { BaseChannel } from "../channels/base.js";
import {
  Annotation,
  AnnotationRoot,
  StateDefinition,
  StateType,
  UpdateType,
} from "./annotation.js";
import { START } from "../constants.js";
import {
  StateGraphAddNodeOptions,
  StateGraphArgs,
  StateGraphNodeSpec,
} from "./state.js";
import { Graph } from "./graph.js";
import { LangGraphRunnableConfig } from "../web.js";

export interface Meta<ValueType, UpdateType = ValueType> {
  metadata?: Record<string, unknown>;
  reducer?: BinaryOperator<ValueType, UpdateType>;
  default?: () => ValueType;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const META_MAP = new WeakMap<z.ZodType, Meta<any, any>>();

type ExtraType<ValueType, UpdateType = ValueType> = z.ZodType<
  ValueType | undefined
> & { "~meta": Meta<ValueType, UpdateType> };

export function extra<ValueType, UpdateType = ValueType>(
  schema: z.ZodType<ValueType | undefined>,
  meta: Meta<ValueType, UpdateType>
): ExtraType<ValueType, UpdateType> {
  if (meta.reducer && !meta.default) {
    const defaultValue =
      // eslint-disable-next-line no-instanceof/no-instanceof
      schema instanceof z.ZodDefault ? schema._def.defaultValue : undefined;
    if (defaultValue) {
      // eslint-disable-next-line no-param-reassign
      meta.default = defaultValue;
    }
  }
  META_MAP.set(schema, meta);
  return schema as ExtraType<ValueType, UpdateType>;
}

export function getMeta<ValueType, UpdateType = ValueType>(
  schema: z.ZodType<ValueType>
): Meta<ValueType, UpdateType> | undefined {
  return META_MAP.get(schema);
}

type Channels<T extends z.ZodRawShape> = {
  [key in keyof T]: BaseChannel<z.infer<T[key]>>;
};

export function getChannels<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const channels = {} as Record<string, BaseChannel>;
  for (const key in schema.shape) {
    if (Object.prototype.hasOwnProperty.call(schema.shape, key)) {
      const keySchema = schema.shape[key];
      const meta = getMeta(keySchema);
      if (meta?.reducer) {
        channels[key] = new BinaryOperatorAggregate<z.infer<T[typeof key]>>(
          meta.reducer,
          meta.default
        );
      } else {
        channels[key] = new LastValue();
      }
    }
  }
  return channels;
}

type ZodToStateDefinition<T extends z.ZodObject<z.ZodRawShape>> = {
  [key in keyof T["shape"]]: T["shape"][key] extends ExtraType<infer V, infer U>
    ? BaseChannel<V, U>
    : T["shape"][key] extends z.ZodType<infer V>
    ? BaseChannel<V>
    : never;
};

type AnyZodObject = z.ZodObject<z.ZodRawShape>;
type SDZod = StateDefinition | AnyZodObject;

type ToStateDefinition<T extends SDZod> = T extends z.ZodObject<z.ZodRawShape>
  ? ZodToStateDefinition<T>
  : T;

// Demo usage
class ZodStateGraph<
  SD extends SDZod,
  S = SD extends SDZod ? StateType<ToStateDefinition<SD>> : SD,
  U = SD extends SDZod ? UpdateType<ToStateDefinition<SD>> : Partial<S>,
  N extends string = typeof START,
  I extends SDZod = SD extends StateDefinition ? SD : StateDefinition,
  O extends SDZod = SD extends StateDefinition ? SD : StateDefinition,
  C extends SDZod = StateDefinition
> extends Graph<N, S, U, StateGraphNodeSpec<S, U>, ToStateDefinition<C>> {
  constructor(
    state: SD extends AnyZodObject
      ? SD
      : SD extends StateDefinition
      ? SD
      : StateGraphArgs<S>,
    configSchema?: C | AnnotationRoot<ToStateDefinition<C>>
  ) {
    super();
  }

  override addNode<K extends string, NodeInput = S>(
    key: K,
    action: RunnableLike<
      NodeInput,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      U extends object ? U & Record<string, any> : U,
      LangGraphRunnableConfig<StateType<ToStateDefinition<C>>>
    >,
    options?: StateGraphAddNodeOptions
  ): ZodStateGraph<SD, S, U, N | K, I, O, C> {
    return this as ZodStateGraph<SD, S, U, N | K, I, O, C>;
  }
}

const oldState = Annotation.Root({
  name: Annotation<string>,
});

const zodState = z.object({
  name: z.string(),
  messages: extra(z.array(z.string()), {
    reducer: (left: string[], right: string | string[]) => [
      ...left,
      ...(Array.isArray(right) ? right : [right]),
    ],
    default: () => [],
    metadata: {},
  }),
});

const graph = new ZodStateGraph(zodState, z.object({ name: z.string() }))
  .addNode("text", (state) => {
    return { messages: ["Hello"] };
  })
  .compile();

// TODO
// - [ ] Config Schema
// - [ ] Add support for zod schema with default value
