// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Values = Record<string, any>;

export abstract class BaseStore {
  abstract list(
    prefixes: string[]
  ): Promise<Record<string, Record<string, Values>>>;

  abstract put(writes: Array<[string, string, Values | null]>): Promise<void>;

  stop(): void {
    // no-op if not implemented.
  }
}
