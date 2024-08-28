import { Interrupt } from "./constants.js";

export class GraphRecursionError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "GraphRecursionError";
  }

  static get unminifiable_name() {
    return "GraphRecursionError";
  }
}

export class GraphValueError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "GraphValueError";
  }

  static get unminifiable_name() {
    return "GraphValueError";
  }
}

export class GraphInterrupt extends Error {
  interrupts: Interrupt[];

  constructor(interrupts: Interrupt[] = []) {
    super(JSON.stringify(interrupts, null, 2));
    this.name = "GraphInterrupt";
    this.interrupts = interrupts;
  }

  static get unminifiable_name() {
    return "GraphInterrupt";
  }
}

/** Raised by a node to interrupt execution. */
export class NodeInterrupt extends GraphInterrupt {
  constructor(interrupt: Interrupt) {
    super([interrupt]);
    this.name = "NodeInterrupt";
  }

  static get unminifiable_name() {
    return "NodeInterrupt";
  }
}

export function isGraphInterrupt(
  e: GraphInterrupt | Error
): e is GraphInterrupt {
  return [
    GraphInterrupt.unminifiable_name,
    NodeInterrupt.unminifiable_name,
  ].includes(e.name);
}

export class EmptyInputError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "EmptyInputError";
  }

  static get unminifiable_name() {
    return "EmptyInputError";
  }
}

export class EmptyChannelError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "EmptyChannelError";
  }

  static get unminifiable_name() {
    return "EmptyChannelError";
  }
}

export class InvalidUpdateError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "InvalidUpdateError";
  }

  static get unminifiable_name() {
    return "InvalidUpdateError";
  }
}
