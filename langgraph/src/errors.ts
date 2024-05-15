export class GraphRecursionError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "GraphRecursionError";
  }
}

export class GraphValueError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "GraphValueError";
  }
}

export class EmptyChannelError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "EmptyChannelError";
  }
}

export class InvalidUpdateError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "InvalidUpdateError";
  }
}
