import { useState } from "react";
import { useStreamLGP } from "./stream.lgp.js";
import { useStreamCustom } from "./stream.custom.js";
import {
  BagTemplate,
  UseStream,
  UseStreamCustom,
  UseStreamCustomOptions,
  UseStreamOptions,
} from "./types.js";

function isCustomOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate
>(
  options:
    | UseStreamOptions<StateType, Bag>
    | UseStreamCustomOptions<StateType, Bag>
): options is UseStreamCustomOptions<StateType, Bag> {
  return "transport" in options;
}

/**
 * A React hook that provides seamless integration with LangGraph streaming capabilities.
 *
 * The `useStream` hook handles all the complexities of streaming, state management, and branching logic,
 * letting you focus on building great chat experiences. It provides automatic state management for
 * messages, interrupts, loading states, and errors.
 *
 * @template StateType The type of the thread state (default: `Record<string, unknown>`)
 * @template Bag Type configuration bag containing:
 *   - `ConfigurableType`: Type for the `config.configurable` property
 *   - `InterruptType`: Type for interrupt values
 *   - `CustomEventType`: Type for custom events
 *   - `UpdateType`: Type for the submit function updates
 *
 * @see {@link https://docs.langchain.com/langgraph-platform/use-stream-react | LangGraph React Integration Guide}
 */
export function useStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate
>(options: UseStreamOptions<StateType, Bag>): UseStream<StateType, Bag>;

/**
 * A React hook that provides seamless integration with LangGraph streaming capabilities.
 *
 * The `useStream` hook handles all the complexities of streaming, state management, and branching logic,
 * letting you focus on building great chat experiences. It provides automatic state management for
 * messages, interrupts, loading states, and errors.
 *
 * @template StateType The type of the thread state (default: `Record<string, unknown>`)
 * @template Bag Type configuration bag containing:
 *   - `ConfigurableType`: Type for the `config.configurable` property
 *   - `InterruptType`: Type for interrupt values
 *   - `CustomEventType`: Type for custom events
 *   - `UpdateType`: Type for the submit function updates
 *
 * @see {@link https://docs.langchain.com/langgraph-platform/use-stream-react | LangGraph React Integration Guide}
 */
export function useStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate
>(
  options: UseStreamCustomOptions<StateType, Bag>
): UseStreamCustom<StateType, Bag>;

/**
 * A React hook that provides seamless integration with LangGraph streaming capabilities.
 *
 * The `useStream` hook handles all the complexities of streaming, state management, and branching logic,
 * letting you focus on building great chat experiences. It provides automatic state management for
 * messages, interrupts, loading states, and errors.
 *
 * @template StateType The type of the thread state (default: `Record<string, unknown>`)
 * @template Bag Type configuration bag containing:
 *   - `ConfigurableType`: Type for the `config.configurable` property
 *   - `InterruptType`: Type for interrupt values
 *   - `CustomEventType`: Type for custom events
 *   - `UpdateType`: Type for the submit function updates
 *
 * @see {@link https://docs.langchain.com/langgraph-platform/use-stream-react | LangGraph React Integration Guide}
 */
export function useStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate
>(options: UseStreamOptions<StateType, Bag>): UseStream<StateType, Bag>;

export function useStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate
>(
  options:
    | UseStreamOptions<StateType, Bag>
    | UseStreamCustomOptions<StateType, Bag>
): UseStream<StateType, Bag> | UseStreamCustom<StateType, Bag> {
  // Store this in useState to make sure we're not changing the implementation in re-renders
  const [isCustom] = useState(isCustomOptions(options));

  if (isCustom) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useStreamCustom(options as UseStreamCustomOptions<StateType, Bag>);
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useStreamLGP(options as UseStreamOptions<StateType, Bag>);
}
