import { useStream as useStreamLGP } from "./streamLgp.js";
import { useStreamCustom } from "./streamCustom.js";
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
  return "variant" in options && options.variant === "custom";
}

export function useStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate
>(
  options: UseStreamOptions<StateType, Bag> & { variant?: "lgp" }
): UseStream<StateType, Bag>;

export function useStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends {
    ConfigurableType?: Record<string, unknown>;
    InterruptType?: unknown;
    CustomEventType?: unknown;
    UpdateType?: unknown;
  } = BagTemplate
>(
  options: UseStreamCustomOptions<StateType, Bag> & { variant: "custom" }
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
    | (UseStreamOptions<StateType, Bag> & { variant?: "lgp" })
    | (UseStreamCustomOptions<StateType, Bag> & { variant: "custom" })
): UseStream<StateType, Bag> | UseStreamCustom<StateType, Bag> {
  if (isCustomOptions(options)) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useStreamCustom(options);
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useStreamLGP(options);
}
