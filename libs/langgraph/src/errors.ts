import { Interrupt } from "./constants.js";

export type BaseLangGraphErrorFields = {
  lc_error_code?: string;
};

// TODO: Merge with base LangChain error class when we drop support for core@0.2.0
export class BaseLangGraphError extends Error {
  lc_error_code?: string;

  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    let finalMessage = message ?? "";
    if (fields?.lc_error_code) {
      finalMessage = `${finalMessage}\n\nTroubleshooting URL: https://js.langchain.com/docs/troubleshooting/errors/${fields.lc_error_code}/\n`;
    }
    super(finalMessage);
    this.lc_error_code = fields?.lc_error_code;
  }
}

export class GraphBubbleUp extends BaseLangGraphError {
  get is_bubble_up() {
    return true;
  }
}

export class GraphRecursionError extends BaseLangGraphError {
  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    super(message, fields);
    this.name = "GraphRecursionError";
  }

  static get unminifiable_name() {
    return "GraphRecursionError";
  }
}

export class GraphValueError extends BaseLangGraphError {
  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    super(message, fields);
    this.name = "GraphValueError";
  }

  static get unminifiable_name() {
    return "GraphValueError";
  }
}

export class GraphInterrupt extends GraphBubbleUp {
  interrupts: Interrupt[];

  constructor(interrupts?: Interrupt[], fields?: BaseLangGraphErrorFields) {
    super(JSON.stringify(interrupts, null, 2), fields);
    this.name = "GraphInterrupt";
    this.interrupts = interrupts ?? [];
  }

  static get unminifiable_name() {
    return "GraphInterrupt";
  }
}

/** Raised by a node to interrupt execution. */
export class NodeInterrupt extends GraphInterrupt {
  constructor(message: string, fields?: BaseLangGraphErrorFields) {
    super(
      [
        {
          value: message,
          when: "during",
        },
      ],
      fields
    );
    this.name = "NodeInterrupt";
  }

  static get unminifiable_name() {
    return "NodeInterrupt";
  }
}

export function isGraphBubbleUp(e?: Error): e is GraphBubbleUp {
  return e !== undefined && (e as GraphBubbleUp).is_bubble_up === true;
}

export function isGraphInterrupt(
  e?: GraphInterrupt | Error
): e is GraphInterrupt {
  return (
    e !== undefined &&
    [
      GraphInterrupt.unminifiable_name,
      NodeInterrupt.unminifiable_name,
    ].includes(e.name)
  );
}

export class EmptyInputError extends BaseLangGraphError {
  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    super(message, fields);
    this.name = "EmptyInputError";
  }

  static get unminifiable_name() {
    return "EmptyInputError";
  }
}

export class EmptyChannelError extends BaseLangGraphError {
  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    super(message, fields);
    this.name = "EmptyChannelError";
  }

  static get unminifiable_name() {
    return "EmptyChannelError";
  }
}

export class InvalidUpdateError extends BaseLangGraphError {
  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    super(message, fields);
    this.name = "InvalidUpdateError";
  }

  static get unminifiable_name() {
    return "InvalidUpdateError";
  }
}

export class MultipleSubgraphsError extends BaseLangGraphError {
  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    super(message, fields);
    this.name = "MultipleSubgraphError";
  }

  static get unminifiable_name() {
    return "MultipleSubgraphError";
  }
}

/**
 * Exception raised when an error occurs in the remote graph.
 */
export class RemoteException extends BaseLangGraphError {
  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    super(message, fields);
    this.name = "RemoteException";
  }

  static get unminifiable_name() {
    return "RemoteException";
  }
}

/**
 * Used for subgraph detection.
 */
export const getSubgraphsSeenSet = () => {
  if (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any)[Symbol.for("LG_CHECKPOINT_SEEN_NS_SET")] === undefined
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any)[Symbol.for("LG_CHECKPOINT_SEEN_NS_SET")] = new Set();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any)[Symbol.for("LG_CHECKPOINT_SEEN_NS_SET")];
};
