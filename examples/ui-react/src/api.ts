export const API_URL =
  (import.meta.env.VITE_LANGGRAPH_API_URL as string | undefined) ??
  "http://localhost:2024";
