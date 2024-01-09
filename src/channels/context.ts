import { BaseChannel } from "./index.js";



/**
 * Exposes the value of a context manager, for the duration of an invocation. 
 * Context manager is entered before the first step, and exited after the last step.
 */
export class Context<Value> extends BaseChannel<Value, undefined, undefined> {
  typ?: new () => Value;

  constructor()

  get ValueType() {
    // todo
  }

  get UpdateType() {
    // todo
  }

  *empty(checkpoiunt?: undefined) {
  }
}
