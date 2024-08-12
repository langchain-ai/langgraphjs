import { RunnableLike } from "@langchain/core/runnables";
import { BaseChannel } from "../channels/base.js";
import { BinaryOperator, BinaryOperatorAggregate } from "../channels/binop.js";
import { LastValue } from "../channels/last_value.js";

export type SingleReducer<ValueType, UpdateType = ValueType> =
  | {
      reducer: BinaryOperator<ValueType, UpdateType>;
      default?: () => ValueType;
    }
  | {
      /**
       * @deprecated Use `reducer` instead
       */
      value: BinaryOperator<ValueType, UpdateType>;
      default?: () => ValueType;
    }
  | null;

export interface StateDefinition {
  [key: string]: BaseChannel | (() => BaseChannel);
}

type ExtractValueType<C> = C extends BaseChannel
  ? C["ValueType"]
  : C extends () => BaseChannel
  ? ReturnType<C>["ValueType"]
  : never;

type ExtractUpdateType<C> = C extends BaseChannel
  ? C["UpdateType"]
  : C extends () => BaseChannel
  ? ReturnType<C>["UpdateType"]
  : never;

export type StateType<SD extends StateDefinition> = {
  [key in keyof SD]: ExtractValueType<SD[key]>;
};

export type UpdateType<SD extends StateDefinition> = {
  [key in keyof SD]?: ExtractUpdateType<SD[key]>;
};

export type NodeType<SD extends StateDefinition> = RunnableLike<
  StateType<SD>,
  UpdateType<SD>
>;

export class AnnotationRoot<SD extends StateDefinition> {
  lc_graph_name = "AnnotationRoot";

  State: StateType<SD>;

  Update: UpdateType<SD>;

  Node: NodeType<SD>;

  spec: SD;

  constructor(s: SD) {
    this.spec = s;
  }
}

export function Annotation<ValueType>(): LastValue<ValueType>;

export function Annotation<ValueType, UpdateType = ValueType>(
  annotation: SingleReducer<ValueType, UpdateType>
): BinaryOperatorAggregate<ValueType, UpdateType>;

export function Annotation<ValueType, UpdateType = ValueType>(
  annotation?: SingleReducer<ValueType, UpdateType>
): BaseChannel<ValueType, UpdateType> {
  if (annotation) {
    return getChannel<ValueType, UpdateType>(annotation);
  } else {
    // @ts-expect-error - Annotation without reducer
    return new LastValue<ValueType>();
  }
}
Annotation.Root = <S extends StateDefinition>(sd: S) => new AnnotationRoot(sd);

export function getChannel<V, U = V>(
  reducer: SingleReducer<V, U>
): BaseChannel<V, U> {
  if (
    typeof reducer === "object" &&
    reducer &&
    "reducer" in reducer &&
    reducer.reducer
  ) {
    return new BinaryOperatorAggregate(reducer.reducer, reducer.default);
  }
  if (
    typeof reducer === "object" &&
    reducer &&
    "value" in reducer &&
    reducer.value
  ) {
    return new BinaryOperatorAggregate(reducer.value, reducer.default);
  }
  // @ts-expect-error - Annotation without reducer
  return new LastValue<V>();
}
