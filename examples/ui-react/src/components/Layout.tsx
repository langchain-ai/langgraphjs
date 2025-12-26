import { useState, useEffect } from "react";
import { Zap } from "lucide-react";
import { Sidebar, SidebarToggle } from "./Sidebar";
import { EXAMPLES, getExample } from "../examples/registry";

/**
 * Import all examples to register them
 */
import "../examples/tool-calling-agent";
import "../examples/human-in-the-loop";
import "../examples/multi-step-graph";
import "../examples/summarization-agent";
import "../examples/parallel-research";
import "../examples/reasoning-agent";
import "../examples/custom-streaming";
import "../examples/browser-tools";

function WelcomeScreen() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-8">
      <div className="w-16 h-16 mb-6 rounded-2xl bg-brand-dark flex items-center justify-center animate-fade-in">
        <span className="text-2xl">🦜🔗</span>
      </div>

      <h1
        className="text-2xl font-semibold text-white mb-3 animate-fade-in"
        style={{ animationDelay: "100ms" }}
      >
        LangGraph Streaming Examples
      </h1>

      <p
        className="text-neutral-400 max-w-md mb-8 animate-fade-in"
        style={{ animationDelay: "200ms" }}
      >
        Explore different streaming patterns with LangGraph. Select an example
        from the sidebar to get started.
      </p>

      <div
        className="grid gap-4 w-full max-w-md animate-fade-in"
        style={{ animationDelay: "300ms" }}
      >
        {EXAMPLES.filter((e) => e.ready)
          .slice(0, 3)
          .map((example) => (
            <div
              key={example.id}
              className="flex items-center gap-4 p-4 rounded-xl bg-neutral-900 border border-neutral-800 hover:border-brand-dark/50 transition-colors text-left"
            >
              <div className="w-10 h-10 rounded-lg bg-brand-dark/20 border border-brand-dark/30 flex items-center justify-center text-brand-accent">
                <Zap className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium text-white">
                  {example.title}
                </h3>
                <p className="text-xs text-neutral-500 truncate">
                  {example.description}
                </p>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

function getExampleFromHash(): string | null {
  const hash = window.location.hash.slice(1); // Remove the '#'
  if (hash && EXAMPLES.some((e) => e.id === hash && e.ready)) {
    return hash;
  }
  return null;
}

export function Layout() {
  const [selectedExample, setSelectedExample] = useState<string | null>(() =>
    getExampleFromHash()
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Sync selected example with URL hash
  useEffect(() => {
    const handleHashChange = () => {
      const exampleFromHash = getExampleFromHash();
      if (exampleFromHash) {
        setSelectedExample(exampleFromHash);
      }
    };

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  // Auto-select first example if none selected
  useEffect(() => {
    if (!selectedExample && EXAMPLES.length > 0) {
      const firstReady = EXAMPLES.find((e) => e.ready);
      if (firstReady) {
        setSelectedExample(firstReady.id);
        window.location.hash = firstReady.id;
      }
    }
  }, [selectedExample]);

  const currentExample = selectedExample ? getExample(selectedExample) : null;
  const ExampleComponent = currentExample?.component;
  return (
    <div className="h-screen flex bg-black">
      <Sidebar
        selectedExample={selectedExample}
        onSelectExample={(id) => {
          setSelectedExample(id);
          window.location.hash = id;
          setSidebarOpen(false);
        }}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
      />

      <main className="flex-1 flex flex-col min-w-0 relative">
        <SidebarToggle onClick={() => setSidebarOpen(true)} />

        {/* Example header */}
        {currentExample && (
          <header className="border-b border-neutral-800 px-6 py-4 flex items-center gap-4 lg:px-8">
            <div className="lg:hidden w-8" />{" "}
            {/* Spacer for mobile menu button */}
            <div>
              <h1 className="text-lg font-semibold text-white">
                {currentExample.title}
              </h1>
              <p className="text-sm text-neutral-500">
                {currentExample.description}
              </p>
            </div>
          </header>
        )}

        {/* Example content */}
        <div className="flex-1 overflow-hidden">
          {ExampleComponent ? <ExampleComponent /> : <WelcomeScreen />}
        </div>
      </main>
    </div>
  );
}
