import type { BaseMessage } from "@langchain/core/messages";
import type {
  StateType,
  UpdateType,
  StateDefinition,
} from "@langchain/langgraph";

// @ts-ignore
type AnyPregel = {
  lg_is_pregel: boolean;
  stream: (...args: any[]) => any;
  invoke: (...args: any[]) => any;
};

// @ts-ignore
type AnyGraph = {
  compiled: boolean;
  compile: (...args: any[]) => any;
};

export type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <
  T
>() => T extends Y ? 1 : 2
  ? true
  : false;

type MatchBaseMessage<T> = T extends BaseMessage ? BaseMessage : never;
type MatchBaseMessageArray<T> = T extends Array<infer C>
  ? Equals<MatchBaseMessage<C>, BaseMessage> extends true
    ? BaseMessage[]
    : never
  : never;

type Defactorify<T> = T extends (...args: any[]) => infer R
  ? Awaited<R>
  : Awaited<T>;

// @ts-ignore
type Inspect<T, TDepth extends Array<0> = []> = TDepth extends [0, 0, 0]
  ? any
  : T extends unknown
  ? {
      [K in keyof T]: 0 extends 1 & T[K]
        ? T[K]
        : Equals<MatchBaseMessageArray<T[K]>, BaseMessage[]> extends true
        ? BaseMessage[]
        : Equals<MatchBaseMessage<T[K]>, BaseMessage> extends true
        ? BaseMessage
        : Inspect<T[K], [0, ...TDepth]>;
    }
  : never;

type ReflectCompiled<T> = T extends { RunInput: infer S; RunOutput: infer U }
  ? { state: S; update: U }
  : T extends { "~InputType": infer InputType; "~OutputType": infer OutputType }
  ? { state: OutputType; update: InputType }
  : never;

// @ts-ignore
type Reflect<T> = Defactorify<T> extends infer DT
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

// @ts-ignore
type BuilderReflect<T> = Defactorify<T> extends infer DT
  ? DT extends {
      compile(...args: any[]): infer Compiled;
    }
    ? BuilderReflectCompiled<Compiled>
    : BuilderReflectCompiled<DT>
  : never;

// @ts-ignore
type FilterAny<T> = 0 extends 1 & T ? never : T;
