import { useState } from "react";
import { StreamProvider } from "@langchain/react";
import "./App.css";
import { StoryExperience } from "./components/StoryExperience";
import { StoryAppProvider } from "./lib/StoryAppProvider";
import type { StoryState } from "./lib/types";

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "http://localhost:2024";
const ASSISTANT_ID = "bedtime-story";

/**
 * Top-level shell for the multimodal story demo.
 *
 * `StreamProvider` owns the LangGraph streaming connection. Bumping `epoch`
 * remounts the provider, giving "Tell me another" a fresh thread-local stream
 * and clearing any media handles from the previous story.
 */
function App() {
  const [epoch, setEpoch] = useState(0);
  return (
    <main className="app">
      <header className="app__hero">
        <h1 className="app__hero-title">Tonight's Story</h1>
        <p className="app__hero-subtitle">
          A tiny illustrated bedtime story, read aloud just for you.
        </p>
      </header>
      <StreamProvider<StoryState>
        key={epoch}
        apiUrl={API_URL}
        assistantId={ASSISTANT_ID}
        transport="sse"
      >
        <StoryAppProvider onReset={() => setEpoch((n) => n + 1)}>
          <StoryExperience />
        </StoryAppProvider>
      </StreamProvider>
    </main>
  );
}

export default App;
