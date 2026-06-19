export const PROXIED_API_URL = "http://localhost:4100/api/chat-langchain";
export const LANGGRAPH_PROXY_API_URL = "http://localhost:4100/api/langgraph";
export const THREAD_ID = "019e6ab9-a2ed-7313-af02-f0e48847601b";

function toUrl(input: URL | RequestInfo): URL {
  // oxlint-disable-next-line no-instanceof/no-instanceof
  return input instanceof URL
    ? input
    : new URL(typeof input === "string" ? input : input.url);
}

export function protocolSuccessResponse(): Response {
  return new Response(
    JSON.stringify({
      type: "success",
      id: 1,
      result: {},
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

export function createFetchRecorder(options?: {
  response?: Response;
  error?: Error;
}): { calls: URL[]; fetch: typeof fetch } {
  const calls: URL[] = [];
  const fetchImpl = ((input: URL | RequestInfo) => {
    calls.push(toUrl(input));
    if (options?.error) {
      return Promise.reject(options.error);
    }
    return Promise.resolve(options?.response ?? protocolSuccessResponse());
  }) as typeof fetch;

  return { calls, fetch: fetchImpl };
}

export function createWebSocketUrlRecorder(): {
  calls: string[];
  webSocketFactory: (url: string) => WebSocket;
  sentinel: Error;
} {
  const calls: string[] = [];
  const sentinel = new Error("websocket-open");
  const webSocketFactory = ((url: string) => {
    calls.push(url);
    throw sentinel;
  }) as (url: string) => WebSocket;

  return { calls, webSocketFactory, sentinel };
}
