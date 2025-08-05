type AnyString = string & {};

declare namespace NodeJS {
  interface ProcessEnv {
    LANGSERVE_GRAPHS: string;
    LANGGRAPH_CONFIG: string | undefined;
    LOG_JSON: "true" | "false" | AnyString | undefined;
    LOG_LEVEL: "debug" | "info" | "warn" | "error" | AnyString | undefined;
    PORT: string;
  }
}
