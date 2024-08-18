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
  constructor(message?: string) {
    super(message);
    this.name = "GraphInterrupt";
  }

  static get unminifiable_name() {
    return "GraphInterrupt";
  }
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
