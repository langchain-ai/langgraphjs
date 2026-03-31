import { useState } from "react";
import { useStreamLGP } from "./stream.lgp.js";
import { useStreamCustom } from "./stream.custom.js";
import type { UseStreamOptions } from "../ui/types.js";
import type { BagTemplate } from "../types.template.js";
import type { UseStreamCustomOptions } from "./types.js";
import type {
  ResolveStreamInterface,
  ResolveStreamOptions,
  InferBag,
  InferStateType,
} from "../ui/stream/index.js";

function isCustomOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options:
    | UseStreamOptions<StateType, Bag>
    | UseStreamCustomOptions<StateType, Bag>
): options is UseStreamCustomOptions<StateType, Bag> {
  return "transport" in options;
}

export function useStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options: ResolveStreamOptions<T, InferBag<T, Bag>>
): ResolveStreamInterface<T, InferBag<T, Bag>>;

export function useStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate,
>(
  options: UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>>
): ResolveStreamInterface<T, InferBag<T, Bag>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useStream(options: any): any {
  // Store this in useState to make sure we're not changing the implementation in re-renders
  const [isCustom] = useState(isCustomOptions(options));

  if (isCustom) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useStreamCustom(options);
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useStreamLGP(options);
}
