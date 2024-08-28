import { EmptyChannelError } from "../errors.js";
import { BaseChannel } from "./base.js";

export type BinaryOperator<ValueType, UpdateType> = (
  a: ValueType,
  b: UpdateType
) => ValueType;

/**
 * Stores the result of applying a binary operator to the current value and each new value.
 */
export class BinaryOperatorAggregate<
  ValueType,
  UpdateType = ValueType
> extends BaseChannel<ValueType, UpdateType, ValueType> {
  lc_graph_name = "BinaryOperatorAggregate";

  value: ValueType | undefined;

  operator: BinaryOperator<ValueType, UpdateType>;

  initialValueFactory?: () => ValueType;

  constructor(
    operator: BinaryOperator<ValueType, UpdateType>,
    initialValueFactory?: () => ValueType
  ) {
    super();

    this.operator = operator;
    this.initialValueFactory = initialValueFactory;
    this.value = initialValueFactory?.();
  }

  public fromCheckpoint(checkpoint?: ValueType) {
    const empty = new BinaryOperatorAggregate(
      this.operator,
      this.initialValueFactory
    );
    if (checkpoint) {
      empty.value = checkpoint;
    }
    return empty as this;
  }

  public update(values: UpdateType[]): boolean {
    let newValues = values;
    if (!newValues.length) return false;

    if (this.value === undefined) {
      [this.value as UpdateType] = newValues;
      newValues = newValues.slice(1);
    }

    for (const value of newValues) {
      if (this.value !== undefined) {
        this.value = this.operator(this.value, value);
      }
    }
    return true;
  }

  public get(): ValueType {
    if (this.value === undefined) {
      throw new EmptyChannelError();
    }
    return this.value;
  }

  public checkpoint(): ValueType {
    if (this.value === undefined) {
      throw new EmptyChannelError();
    }
    return this.value;
  }
}
