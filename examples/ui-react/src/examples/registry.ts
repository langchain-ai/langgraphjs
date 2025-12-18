import type { ComponentType } from "react";

/**
 * Example metadata for display in the sidebar
 */
export interface ExampleMeta {
  /** Unique identifier for the example */
  id: string;
  /** Display title in the sidebar */
  title: string;
  /** Short description of what the example demonstrates */
  description: string;
  /** Category for grouping examples */
  category: "agents" | "middleware" | "langgraph" | "advanced";
  /** Icon name (matched in Sidebar component) */
  icon: "tool" | "graph" | "middleware" | "code" | "chat";
  /** Whether this example is ready (false = coming soon) */
  ready: boolean;
}

/**
 * Full example definition including the component
 */
export interface ExampleDefinition extends ExampleMeta {
  /** The React component that renders the example */
  component: ComponentType;
}

/**
 * Category metadata for sidebar grouping
 */
export const CATEGORIES: Record<
  ExampleMeta["category"],
  { label: string; description: string }
> = {
  agents: {
    label: "Agents",
    description: "Tool-calling and agentic workflows",
  },
  langgraph: {
    label: "LangGraph",
    description: "Graph-based conversation flows",
  },
  middleware: {
    label: "Middleware",
    description: "Custom middleware patterns",
  },
  advanced: {
    label: "Advanced",
    description: "Complex streaming scenarios",
  },
};

/**
 * Registry of all available examples.
 * To add a new example:
 * 1. Create a new file in src/examples/your-example/
 * 2. Export your component and metadata
 * 3. Import and add to this array
 */
export const EXAMPLES: ExampleDefinition[] = [];

/**
 * Register an example. Use this to add examples from their own modules.
 */
export function registerExample(example: ExampleDefinition): void {
  EXAMPLES.push(example);
}

/**
 * Get an example by ID
 */
export function getExample(id: string): ExampleDefinition | undefined {
  return EXAMPLES.find((e) => e.id === id);
}

/**
 * Get examples grouped by category
 */
export function getExamplesByCategory(): Map<
  ExampleMeta["category"],
  ExampleDefinition[]
> {
  const grouped = new Map<ExampleMeta["category"], ExampleDefinition[]>();

  for (const category of Object.keys(CATEGORIES) as ExampleMeta["category"][]) {
    grouped.set(category, []);
  }

  for (const example of EXAMPLES) {
    const categoryExamples = grouped.get(example.category) || [];
    categoryExamples.push(example);
    grouped.set(example.category, categoryExamples);
  }

  return grouped;
}
