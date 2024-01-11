import { BaseChannel, EmptyChannelError } from "./index.js";

type BinaryOperator<Value> = (a: Value, b: Value) => Value;

/**
 * Stores the result of applying a binary operator to the current value and each new value.
 */
export class BinaryOperatorAggregate<Value> extends BaseChannel<
  Value,
  Value,
  Value
> {
  lc_graph_name = "BinaryOperatorAggregate";

  value: Value | undefined;

  typ?: Value;

  operator: BinaryOperator<Value>;

  constructor(operator: BinaryOperator<Value>, initialValue?: Value) {
    super();

    this.operator = operator;
    try {
      this.value = initialValue ?? this.typ;
    } catch (e) {
      // no-op
    }
  }

  /**
   * The type of the value stored in the channel.
   *
   * @returns {Value | undefined}
   */
  public get ValueType(): Value | undefined {
    return this.typ;
  }

  /**
   * The type of the update received by the channel.
   *
   * @returns {Value | undefined}
   */
  public get UpdateType(): Value | undefined {
    return this.typ;
  }

  public *empty(
    checkpoint?: Value,
    initialValue?: Value
  ): Generator<BinaryOperatorAggregate<Value>> {
    const empty = new BinaryOperatorAggregate(this.operator, initialValue);
    if (checkpoint) {
      empty.value = checkpoint;
    }

    try {
      yield empty;
    } finally {
      try {
        delete empty.value;
      } catch (_) {
        // no-op
      }
    }
  }

  public update(values: Value[]): void {
    let newValues = values;
    if (!newValues.length) return;

    if (this.value === undefined) {
      [this.value] = newValues;
      newValues = newValues.slice(1);
    }

    for (const value of newValues) {
      if (this.value !== undefined) {
        this.value = this.operator(this.value, value);
      }
    }
  }

  public get(): Value {
    if (this.value === undefined) {
      throw new EmptyChannelError();
    }
    return this.value;
  }

  public checkpoint(): Value {
    if (!this.value) {
      throw new EmptyChannelError();
    }
    return this.value;
  }
}
