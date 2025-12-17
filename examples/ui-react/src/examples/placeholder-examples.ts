import { registerExample } from "./registry";

/**
 * Placeholder examples to demonstrate the extensibility of the sidebar.
 * These are marked as `ready: false` and will show "Coming Soon" in the UI.
 *
 * To implement an example:
 * 1. Create a new directory under src/examples/
 * 2. Create your component and agent
 * 3. Change `ready: false` to `ready: true`
 * 4. Import and use `registerExample` with your component
 */

// Custom Middleware Example
registerExample({
  id: "custom-middleware",
  title: "Custom Middleware",
  description: "Add logging, rate limiting, or custom logic to your streaming pipeline",
  category: "middleware",
  icon: "middleware",
  ready: false,
  component: () => null,
});

// Streaming with Subgraphs Example
registerExample({
  id: "subgraphs",
  title: "Subgraphs",
  description: "Compose multiple graphs together for complex workflows",
  category: "advanced",
  icon: "code",
  ready: false,
  component: () => null,
});

// Parallel Tool Execution Example
registerExample({
  id: "parallel-tools",
  title: "Parallel Tool Execution",
  description: "Execute multiple tools concurrently and stream results as they complete",
  category: "agents",
  icon: "tool",
  ready: false,
  component: () => null,
});

