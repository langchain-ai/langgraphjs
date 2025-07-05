export class TimeoutError extends Error {}
export class AbortError extends Error {}

export type GET_OPTIONS = {
  timeout: number;
  lastEventId?: string;
  signal?: AbortSignal
}
export interface Message {
  topic: `run:${string}:stream:${string}`;
  data: unknown;
}
export interface QueueInterface {
  push(item: Message): Promise<void>;
  get(options: GET_OPTIONS): Promise<[id: string, message: Message]>;
  cleanup(): Promise<boolean>;
}