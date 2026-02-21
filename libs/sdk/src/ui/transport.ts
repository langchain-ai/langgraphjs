import type { BagTemplate } from "../types.template.js";
import type { Command } from "../types.js";
import type {
  GetUpdateType,
  GetConfigurableType,
  UseStreamTransport,
} from "./types.js";
import { BytesLineDecoder, SSEDecoder } from "../utils/sse.js";
import { IterableReadableStream } from "../utils/stream.js";

interface FetchStreamTransportOptions {
  /**
   * The URL of the API to use.
   */
  apiUrl: string;

  /**
   * Default headers to send with requests.
   */
  defaultHeaders?: HeadersInit;

  /**
   * Specify a custom fetch implementation.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetch?: typeof fetch | ((...args: any[]) => any);

  /**
   * Callback that is called before the request is made.
   */
  onRequest?: (
    url: string,
    init: RequestInit
  ) => Promise<RequestInit> | RequestInit;
}

export class FetchStreamTransport<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> implements UseStreamTransport<StateType, Bag>
{
  constructor(private readonly options: FetchStreamTransportOptions) {}

  async stream(payload: {
    input: GetUpdateType<Bag, StateType> | null | undefined;
    context: GetConfigurableType<Bag> | undefined;
    command: Command | undefined;
    signal: AbortSignal;
  }): Promise<AsyncGenerator<{ id?: string; event: string; data: unknown }>> {
    const { signal, ...body } = payload;

    let requestInit: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.options.defaultHeaders,
      },
      body: JSON.stringify(body),
      signal,
    };

    if (this.options.onRequest) {
      requestInit = await this.options.onRequest(
        this.options.apiUrl,
        requestInit
      );
    }
    const fetchFn = this.options.fetch ?? fetch;

    const response = await fetchFn(this.options.apiUrl, requestInit);
    if (!response.ok) {
      throw new Error(`Failed to stream: ${response.statusText}`);
    }

    const stream = (
      response.body || new ReadableStream({ start: (ctrl) => ctrl.close() })
    )
      .pipeThrough(BytesLineDecoder())
      .pipeThrough(SSEDecoder());

    return IterableReadableStream.fromReadableStream(stream);
  }
}
