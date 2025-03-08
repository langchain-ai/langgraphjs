import type { BaseMessage } from "@langchain/core/messages";
import type {
  StateType,
  UpdateType,
  StateDefinition,
} from "@langchain/langgraph";
import type { Graph } from "@langchain/langgraph";
import type { Pregel } from "@langchain/langgraph/pregel";

// @ts-expect-error
type AnyPregel = Pregel<any, any>;

// @ts-expect-error
type AnyGraph = Graph<any, any, any, any, any>;

type Wrap<T> = (a: T) => void;
type MatchBaseMessage<T> = T extends BaseMessage ? BaseMessage : never;
type MatchBaseMessageArray<T> =
  T extends Array<infer C>
    ? Wrap<MatchBaseMessage<C>> extends Wrap<BaseMessage>
      ? BaseMessage[]
      : never
    : never;

type Defactorify<T> = T extends (...args: any[]) => infer R
  ? Awaited<R>
  : Awaited<T>;

// @ts-expect-error
type Inspect<T, TDepth extends Array<0> = []> = TDepth extends [0, 0, 0]
  ? any
  : T extends unknown
    ? {
        [K in keyof T]: 0 extends 1 & T[K]
          ? T[K]
          : Wrap<MatchBaseMessageArray<T[K]>> extends Wrap<BaseMessage[]>
            ? BaseMessage[]
            : Wrap<MatchBaseMessage<T[K]>> extends Wrap<BaseMessage>
              ? BaseMessage
              : Inspect<T[K], [0, ...TDepth]>;
      }
    : never;

type ReflectCompiled<T> = T extends { RunInput: infer S; RunOutput: infer U }
  ? { state: S; update: U }
  : T extends { "~InputType": infer InputType; "~OutputType": infer OutputType }
    ? { state: OutputType; update: InputType }
    : never;

// @ts-expect-error
type Reflect<T> =
  Defactorify<T> extends infer DT
    ? DT extends {
        compile(...args: any[]): infer Compiled;
      }
      ? ReflectCompiled<Compiled>
      : ReflectCompiled<DT>
    : never;

type BuilderReflectCompiled<T> = T extends {
  builder: {
    _inputDefinition: infer I extends StateDefinition;
    _outputDefinition: infer O extends StateDefinition;
    _configSchema?: infer C extends StateDefinition | undefined;
  };
}
  ? {
      input: UpdateType<I>;
      output: StateType<O>;
      config: UpdateType<Exclude<C, undefined>>;
    }
  : never;

// @ts-expect-error
type BuilderReflect<T> =
  Defactorify<T> extends infer DT
    ? DT extends {
        compile(...args: any[]): infer Compiled;
      }
      ? BuilderReflectCompiled<Compiled>
      : BuilderReflectCompiled<DT>
    : never;

// @ts-expect-error
type FilterAny<T> = 0 extends 1 & T ? never : T;
