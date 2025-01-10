import { register } from "node:module";

// enforce API @langchain/langgraph precedence
register("./graph/load.hooks.mjs", import.meta.url);
