import { Suggestion, Suggestions } from "./ai-elements/suggestion";

const PRESET_PROMPTS = [
  "What's the weather in Tokyo?",
  "Search for the latest AI news",
  "Write a Python quicksort implementation",
];

interface SuggestionsScreenProps {
  onSelect: (prompt: string) => void;
}

export function SuggestionsScreen({ onSelect }: SuggestionsScreenProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-4">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          What can I help you with?
        </h1>
        <p className="text-sm text-muted-foreground">
          I can check the weather or search the web for you.
        </p>
      </div>
      <Suggestions>
        {PRESET_PROMPTS.map((prompt) => (
          <Suggestion key={prompt} suggestion={prompt} onClick={onSelect} />
        ))}
      </Suggestions>
    </div>
  );
}
