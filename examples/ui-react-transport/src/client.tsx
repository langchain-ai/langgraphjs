import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";

import { StreamProvider } from "@langchain/react";

import { A2AProjectionPanel } from "./components/A2AProjectionPanel";
import { Chat } from "./components/Chat";
import { HeroCard } from "./components/HeroCard";
import { Prompt } from "./components/Prompt";

import { ThemeProvider, ThemeToggle, useTheme } from "./provider/theme";

import { LocalStreamTransport } from "./transport";
import type { GraphType } from "./app";

import "./styles.css";

function App() {
  const transport = useMemo(() => new LocalStreamTransport("/api/stream"), []);
  const { theme } = useTheme();

  return (
    <main className={`chat-shell ${theme === "light" ? "light" : ""}`}>
      <StreamProvider<GraphType> transport={transport}>
        <ThemeToggle />
        <HeroCard />
        <Chat />
        <A2AProjectionPanel />
        <Prompt />
      </StreamProvider>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>
);
