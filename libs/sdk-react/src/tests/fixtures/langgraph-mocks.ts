/**
 * Mocked LangGraph types for type tests.
 *
 * These mocks exist because @langchain/langgraph-sdk is a dependency of
 * @langchain/langgraph, creating a circular dependency if we try to import
 * LangGraph primitives directly in tests.
 *
 * The mocks replicate the phantom type pattern used by the real
 * CompiledStateGraph, StateGraph, and StateSchema.
 */

import { z } from "zod/v4";
import type { Message } from "@langchain/langgraph-sdk";

// ============================================================================
// StateGraph Mocks
// ============================================================================

export interface MockCompiledGraph<
  TState extends Record<string, unknown>,
  TNodeNames extends string,
  TNodeReturnTypes extends Record<string, Record<string, unknown>>
> {
  "~RunOutput": TState;
  "~NodeType": TNodeNames;
  "~NodeReturnType": TNodeReturnTypes;
}

export class MockStateGraph<
  TState extends Record<string, unknown>,
  TNodeNames extends string = never,
  TNodeReturnTypes extends Record<string, Record<string, unknown>> = Record<
    string,
    never
  >
> {
  constructor(_schema: { State: TState }) {}

  addNode<K extends string, TReturn extends Partial<TState>>(
    _name: K,
    _fn: (state: TState) => Promise<TReturn>
  ): MockStateGraph<
    TState,
    TNodeNames | K,
    TNodeReturnTypes & { [key in K]: TReturn }
  > {
    return this as unknown as MockStateGraph<
      TState,
      TNodeNames | K,
      TNodeReturnTypes & { [key in K]: TReturn }
    >;
  }

  addEdge(_from: string, _to: string): this {
    return this;
  }

  compile(): MockCompiledGraph<TState, TNodeNames, TNodeReturnTypes> {
    return {} as MockCompiledGraph<TState, TNodeNames, TNodeReturnTypes>;
  }
}

export const START = "__start__" as const;
export const END = "__end__" as const;

// ============================================================================
// State Schema Mocks
// ============================================================================

export class MockReducedValue<T> {
  declare "~value": T;
}

export const MessagesValue = new MockReducedValue<Message[]>();

export class MockStateSchema<TFields extends Record<string, unknown>> {
  declare State: {
    [K in keyof TFields]: TFields[K] extends MockReducedValue<infer V>
      ? V
      : TFields[K] extends z.ZodType
      ? z.infer<TFields[K]>
      : TFields[K];
  };

  constructor(_fields: TFields) {}
}
