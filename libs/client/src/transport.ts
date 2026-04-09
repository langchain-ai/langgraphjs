import type {
  Command,
  CommandResponse,
  ErrorResponse,
  Message,
  SessionOpenParams,
  SessionResult,
} from "@langchain/protocol";

export interface TransportAdapter {
  open(params: SessionOpenParams): Promise<SessionResult>;
  send(command: Command): Promise<CommandResponse | ErrorResponse | void>;
  events(): AsyncIterable<Message>;
  close(): Promise<void>;
}

