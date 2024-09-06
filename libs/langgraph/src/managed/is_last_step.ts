import { RECURSION_LIMIT_DEFAULT } from "../constants.js";
import { ManagedValue } from "./base.js";

export class IsLastStepManager extends ManagedValue<boolean> {
  call(step: number): boolean {
    return step === (this.config.recursionLimit ?? RECURSION_LIMIT_DEFAULT) - 1;
  }

  /**
   * Implemented here because it's abstract in ManagedValue.
   * @returns {Promise<false>} Always returns false.
   */
  tick(): Promise<false> {
    return Promise.resolve(false);
  }
}
