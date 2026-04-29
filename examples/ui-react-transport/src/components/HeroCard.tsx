export function HeroCard() {
  return (
    <section className="hero-card">
      <div aria-label="React logo" className="framework-logo" role="img">
        <svg viewBox="-11.5 -10.23174 23 20.46348">
          <circle cx="0" cy="0" fill="#61dafb" r="2.05" />
          <g fill="none" stroke="#61dafb" strokeWidth="1">
            <ellipse rx="11" ry="4.2" />
            <ellipse rx="11" ry="4.2" transform="rotate(60)" />
            <ellipse rx="11" ry="4.2" transform="rotate(120)" />
          </g>
        </svg>
      </div>
      <div className="eyebrow">langgraph streaming</div>
      <div className="hero-copy">
        <h1>React Chat</h1>
        <p>
          A compact chat example powered by <code>@langchain/react</code> and a
          custom backend connected through a local transport adapter.
        </p>
      </div>
    </section>
  );
}
