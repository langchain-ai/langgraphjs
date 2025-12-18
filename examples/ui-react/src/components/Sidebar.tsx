import {
  Wrench,
  GitBranch,
  Layers,
  Code,
  MessageCircle,
  X,
  Menu,
  BookOpen,
  ExternalLink,
} from "lucide-react";
import { CATEGORIES, getExamplesByCategory, type ExampleMeta } from "../examples/registry";

interface SidebarProps {
  selectedExample: string | null;
  onSelectExample: (id: string) => void;
  isOpen: boolean;
  onToggle: () => void;
}

const ICONS: Record<ExampleMeta["icon"], React.ReactNode> = {
  tool: <Wrench className="w-4 h-4" strokeWidth={1.5} />,
  graph: <GitBranch className="w-4 h-4" strokeWidth={1.5} />,
  middleware: <Layers className="w-4 h-4" strokeWidth={1.5} />,
  code: <Code className="w-4 h-4" strokeWidth={1.5} />,
  chat: <MessageCircle className="w-4 h-4" strokeWidth={1.5} />,
};

export function Sidebar({ selectedExample, onSelectExample, isOpen, onToggle }: SidebarProps) {
  const examplesByCategory = getExamplesByCategory();

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden"
          onClick={onToggle}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed lg:static inset-y-0 left-0 z-50
          w-72 bg-neutral-950 border-r border-neutral-800
          transform transition-transform duration-200 ease-out
          ${isOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
          flex flex-col
        `}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-5 border-b border-neutral-800">
          <div className="h-8 px-2 rounded-lg flex items-center justify-center bg-brand-dark">
            <span className="text-sm leading-none whitespace-nowrap">🦜🔗</span>
          </div>
          <div>
            <h1 className="text-sm font-semibold text-white">LangGraph UI</h1>
            <p className="text-xs text-neutral-500">Streaming Examples</p>
          </div>
          <button
            onClick={onToggle}
            className="lg:hidden ml-auto p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Examples list */}
        <nav className="flex-1 overflow-y-auto py-4 px-3">
          {Array.from(examplesByCategory.entries()).map(([category, examples]) => {
            if (examples.length === 0) return null;

            const categoryMeta = CATEGORIES[category];

            return (
              <div key={category} className="mb-6">
                <div className="px-2 mb-2">
                  <h2 className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">
                    {categoryMeta.label}
                  </h2>
                </div>

                <div className="space-y-1">
                  {examples.map((example) => {
                    const isSelected = selectedExample === example.id;

                    return (
                      <button
                        key={example.id}
                        onClick={() => example.ready && onSelectExample(example.id)}
                        disabled={!example.ready}
                        className={`
                          w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left
                          transition-all duration-150 border cursor-pointer
                          ${
                            isSelected
                              ? "bg-brand-dark/30 text-white border-brand-dark/50"
                              : example.ready
                              ? "text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200 border-transparent"
                              : "text-neutral-600 cursor-not-allowed border-transparent"
                          }
                        `}
                      >
                        <span
                          className={`
                            mt-0.5 flex-shrink-0
                            ${isSelected ? "text-brand-accent" : example.ready ? "text-neutral-500" : "text-neutral-700"}
                          `}
                        >
                          {ICONS[example.icon]}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">{example.title}</span>
                            {!example.ready && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-500 font-medium">
                                Soon
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-neutral-500 mt-0.5 line-clamp-2">
                            {example.description}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="px-4 py-4 border-t border-neutral-800">
          <a
            href="https://docs.langchain.com/#typescript"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-xs text-neutral-500 hover:text-brand-accent transition-colors"
          >
            <BookOpen className="w-4 h-4" strokeWidth={1.5} />
            <span>Documentation</span>
            <ExternalLink className="w-3 h-3 ml-auto" />
          </a>
        </div>
      </aside>
    </>
  );
}

/**
 * Toggle button for mobile sidebar
 */
export function SidebarToggle({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="lg:hidden fixed top-4 left-4 z-30 p-2 rounded-lg bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-brand-accent hover:border-brand-dark transition-colors"
    >
      <Menu className="w-5 h-5" />
    </button>
  );
}
