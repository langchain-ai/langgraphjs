/**
 * Mocked LangGraph types for type tests.
 *
 * ⚠️ CIRCULAR DEPENDENCY WORKAROUND
 *
 * These mocks exist because @langchain/langgraph-sdk is a dependency of
 * @langchain/langgraph, creating a circular dependency if we try to import
 * LangGraph primitives here for testing.
 *
 * This will be resolved once we separate the SDK into:
 * - @langchain/langgraph-client (BaseClient, API types)
 * - @langchain/langgraph-react (useStream, React hooks)
 *
 * At that point, the React package can depend on @langchain/langgraph
 * without creating a cycle.
 *
 * NOTE: We can still import from `langchain` and `deepagents` packages
 * as they don't have this circular dependency issue.
 */

import { z } from "zod/v4";
import type { Message } from "../../types.messages.js";

// ============================================================================
// StateGraph Mocks
// ============================================================================

/**
 * Mock CompiledStateGraph with phantom types for state and nodes.
 * Matches the phantom type pattern used by @langchain/langgraph.
 */
export interface MockCompiledGraph<
  TState extends Record<string, unknown>,
  TNodeNames extends string,
  TNodeReturnTypes extends Record<string, Record<string, unknown>>
> {
  "~RunOutput": TState;
  "~NodeType": TNodeNames;
  "~NodeReturnType": TNodeReturnTypes;
}

/**
 * Simplified StateGraph builder for type tests.
 * Accumulates node names and return types as type parameters.
 */
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

/**
 * Mock ReducedValue for message arrays and other reduced values.
 */
export class MockReducedValue<T> {
  declare "~value": T;
}

/**
 * Pre-configured MessagesValue for message arrays.
 */
export const MessagesValue = new MockReducedValue<Message[]>();

/**
 * Mock StateSchema that infers state type from fields.
 * Matches the StateSchema pattern from @langchain/langgraph.
 */
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
