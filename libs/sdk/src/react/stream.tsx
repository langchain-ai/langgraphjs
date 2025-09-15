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
  return "transport" in options && options.transport !== undefined;
}

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
  options: UseStreamCustomOptions<StateType, Bag>
): UseStreamCustom<StateType, Bag>;

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
