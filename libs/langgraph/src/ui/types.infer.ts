/* eslint-disable @typescript-eslint/no-explicit-any */
import type { BaseMessage } from "@langchain/core/messages";
import type { SerializedMessage } from "./types.message.js";

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

type ReplaceMessages<T, TDepth extends Array<0> = []> = TDepth extends [0, 0, 0]
  ? any
  : T extends unknown
  ? {
      [K in keyof T]: 0 extends 1 & T[K]
        ? T[K]
        : Equals<MatchBaseMessageArray<T[K]>, BaseMessage[]> extends true
        ? SerializedMessage.AnyMessage[]
        : Equals<MatchBaseMessage<T[K]>, BaseMessage> extends true
        ? SerializedMessage.AnyMessage
        : ReplaceMessages<T[K], [0, ...TDepth]>;
    }
  : never;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Defactorify<T> = T extends (...args: any[]) => infer R
  ? Awaited<R>
  : Awaited<T>;

type AnyPregel = {
  lg_is_pregel: boolean;
  stream: (...args: any[]) => any;
  invoke: (...args: any[]) => any;
};

type AnyGraph = {
  compiled: boolean;
  compile: (...args: any[]) => any;
};

export type AnyPregelLike =
  | AnyPregel
  | AnyGraph
  | ((...args: any[]) => AnyPregel | AnyGraph);

type ReflectCompiledGraph<T> = T extends {
  RunInput: infer State;
  RunOutput: infer Update;
  "~NodeReturnType"?: infer ReturnType;
}
  ? {
      state: ReplaceMessages<State>;
      update: ReplaceMessages<Update>;
      returnType: ReturnType;
    }
  : T extends { "~InputType": infer InputType; "~OutputType": infer OutputType }
  ? { state: ReplaceMessages<OutputType>; update: ReplaceMessages<InputType> }
  : never;

export type InferGraph<T> = Defactorify<T> extends infer DT
  ? DT extends {
      compile(...args: any[]): infer Compiled;
    }
    ? ReflectCompiledGraph<Compiled>
    : ReflectCompiledGraph<DT>
  : never;
