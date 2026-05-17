export type Transport = "sse" | "websocket";

export const API_URL =
  (import.meta.env.VITE_LANGGRAPH_API_URL as string | undefined) ??
  "http://localhost:2024";

export const TRANSPORT_LABEL: Record<Transport, string> = {
  sse: "HTTP + SSE",
  websocket: "WebSocket",
};

export const isTransport = (value: string | null): value is Transport =>
  value === "sse" || value === "websocket";
