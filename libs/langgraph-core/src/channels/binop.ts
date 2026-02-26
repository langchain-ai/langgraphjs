import {
  _getOverwriteValue,
  _isOverwriteValue,
  type OverwriteValue,
} from "../constants.js";
import { EmptyChannelError, InvalidUpdateError } from "../errors.js";
import { BaseChannel } from "./base.js";

type OverwriteOrValue<ValueType, UpdateType> =
  | OverwriteValue<ValueType>
  | UpdateType;

export type BinaryOperator<ValueType, UpdateType> = (
  a: ValueType,
  b: UpdateType
) => ValueType;

const isBinaryOperatorAggregate = (
  value: BaseChannel
): value is BinaryOperatorAggregate<unknown, unknown> => {
  return value != null && value.lc_graph_name === "BinaryOperatorAggregate";
};

/**
 * Stores the result of applying a binary operator to the current value and each new value.
 */
export class BinaryOperatorAggregate<
  ValueType,
  UpdateType = ValueType
> extends BaseChannel<
  ValueType,
  OverwriteOrValue<ValueType, UpdateType>,
  ValueType
> {
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
    if (typeof checkpoint !== "undefined") {
      empty.value = checkpoint;
    }
    return empty as this;
  }

  public update(values: OverwriteOrValue<ValueType, UpdateType>[]): boolean {
    let newValues = values;
    if (!newValues.length) return false;

    if (this.value === undefined) {
      const first = newValues[0];
      const [isOverwrite, overwriteVal] = _getOverwriteValue<ValueType>(first);
      if (isOverwrite) {
        this.value = overwriteVal;
      } else {
        this.value = first as ValueType;
      }
      newValues = newValues.slice(1);
    }

    let seenOverwrite = false;
    for (const incoming of newValues) {
      if (_isOverwriteValue<ValueType>(incoming)) {
        if (seenOverwrite) {
          throw new InvalidUpdateError(
            "Can receive only one Overwrite value per step."
          );
        }
        const [, val] = _getOverwriteValue<ValueType>(incoming);
        this.value = val;
        seenOverwrite = true;
        continue;
      } else if (!seenOverwrite && this.value !== undefined) {
        this.value = this.operator(this.value, incoming);
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

  isAvailable(): boolean {
    return this.value !== undefined;
  }

  /**
   * Compare this channel with another channel for equality.
   * Two BinaryOperatorAggregate channels are equal if they have the same operator function.
   * This follows the Python implementation which compares operator references.
   */
  equals(other: BaseChannel): boolean {
    if (this === other) return true;
    if (!isBinaryOperatorAggregate(other)) return false;
    return this.operator === other.operator;
  }
}
