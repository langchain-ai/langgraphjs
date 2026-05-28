export interface StorybookHeaderProps {
  /** Derived from the first few words of the story once enough text exists. */
  title: string;
  /** True while the storyteller is still producing page text. */
  isStreaming: boolean;
  /** Whether the provider is currently chain-playing all page narrations. */
  chainPlayEnabled: boolean;
  /** Toggles sequential playback of the three page narrations. */
  onToggleChainPlay: () => void;
}

/** Header displayed once a story starts streaming. */
export function StorybookHeader({
  title,
  isStreaming,
  chainPlayEnabled,
  onToggleChainPlay,
}: StorybookHeaderProps) {
  return (
    <div className="storybook-header">
      <h2 className="storybook-header__title">
        {title || "Once upon a time…"}
        {isStreaming ? <span className="storybook-header__title-caret" /> : null}
      </h2>
      <div className="storybook-header__actions">
        <button
          type="button"
          className={`icon-toggle${chainPlayEnabled ? " icon-toggle--active" : ""}`}
          onClick={onToggleChainPlay}
          aria-pressed={chainPlayEnabled}
          title="Read the whole story aloud"
        >
          <span aria-hidden>{chainPlayEnabled ? "🔊" : "🔈"}</span>
          Read aloud
        </button>
      </div>
    </div>
  );
}
