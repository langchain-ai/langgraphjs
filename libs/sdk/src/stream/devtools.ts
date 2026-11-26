import type { Event } from "@langchain/protocol";
import type { StreamController } from "./controller.js";
import type { RootSnapshot } from "./types.js";
import type { Message } from "../types.messages.js";

/** Versioned, JSON-compatible recording of received events, not local commands. */
export type StreamDevtoolsRecord =
  | {
      version: 1;
      type: "baseline";
      messagesKey: string;
      snapshot: Omit<RootSnapshot, "messages" | "interrupt" | "error"> & {
        messages: Message[];
      };
      checkpointTime?: number;
      checkpoint?: { id: string; parent_id?: string; step?: number };
    }
  | {
      version: 1;
      type: "event";
      source: "root" | "wildcard";
      event: Event;
    };

/** Opt-in received-event recorder with one isolated replay controller. */
export class StreamDevtoolsSession {
  readonly #onRecord: (record: StreamDevtoolsRecord) => void;
  readonly #listeners = new Set<() => void>();
  #createReplay: (() => StreamController) | undefined;
  #owner: object | undefined;
  #replay: StreamController | undefined;
  #mode: "live" | "replay" = "live";
  #revision = 0;

  /** @internal */
  getRevision = (): number => this.#revision;

  constructor(options: { onRecord: (record: StreamDevtoolsRecord) => void }) {
    this.#onRecord = options.onRecord;
  }

  getSnapshot = (): "live" | "replay" => this.#mode;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Start a fresh seek; the caller supplies the baseline and disk prefix. */
  reset(): void {
    if (!this.#createReplay)
      throw new Error("Devtools session is not attached");
    void this.#replay?.dispose();
    this.#replay = this.#createReplay();
    this.#mode = "replay";
    this.#notify();
  }

  /** Apply one externally stored record in its original delivery order. */
  apply(record: StreamDevtoolsRecord): void {
    if (!this.#replay) throw new Error("Call reset() before applying records");
    this.#replay.applyDevtoolsRecord(record);
  }

  /** Flush batched message assembly after applying a prefix. */
  flush(): void {
    this.#replay?.flushDevtools();
    this.#notify();
  }

  /** Restore the live controller, which continues receiving during replay. */
  live(): void {
    this.#mode = "live";
    void this.#replay?.dispose();
    this.#replay = undefined;
    this.#notify();
  }

  /** @internal */
  attach(owner: object, createReplay: () => StreamController): void {
    if (this.#owner !== owner && this.#replay) this.live();
    this.#owner = owner;
    this.#createReplay = createReplay;
  }

  /** @internal */
  detach(owner: object): void {
    if (this.#owner !== owner) return;
    this.live();
    this.#owner = undefined;
    this.#createReplay = undefined;
  }

  /** @internal */
  record(owner: object, record: StreamDevtoolsRecord): void {
    if (this.#owner !== owner) return;
    try {
      this.#onRecord(
        JSON.parse(JSON.stringify(record)) as StreamDevtoolsRecord
      );
    } catch {
      console.warn("Stream devtools recording failed");
    }
  }

  /** @internal */
  display<S extends object, I, C extends object>(
    live: StreamController<S, I, C>
  ): StreamController<S, I, C> {
    return (this.#replay as unknown as StreamController<S, I, C>) ?? live;
  }

  #notify(): void {
    this.#revision += 1;
    for (const listener of this.#listeners) listener();
  }
}
