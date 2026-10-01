---
"@langchain/langgraph-sdk": minor
---

Add experimental MCP Apps (SEP-1865) support to `@langchain/langgraph-sdk/react`: `experimental_useMCPApps` finds the tool calls in a thread that ship a `ui://` view, and `experimental_MCPApp` renders one in a sandboxed iframe, owning the SEP-1865 handshake, lifecycle and tool-input ordering. `@modelcontextprotocol/ext-apps` is an optional peer dependency, so a host that renders no apps installs nothing extra.
