// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type V = Record<string, any>;

export abstract class BaseStore {
  abstract list(prefixes: string[]): Promise<Record<string, Record<string, V>>>;

  abstract put(writes: Array<[string, string, V | null]>): Promise<void>;
}
