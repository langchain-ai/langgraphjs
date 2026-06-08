# Integration tests — JS graphs on the managed langgraph-api server

Ported from `langgraph-api/api/langgraph_api/js/tests`. This is the same
integration framework the Python `langgraph-api` repo uses to run **JS graphs on
the real managed server** (Go core + Python orchestrator + Node subprocess via
`RemotePregel`), driven by the `@langchain/langgraph-sdk` client over HTTP.

It exists so a JS change that breaks the *managed* runtime gets caught here. The
in-repo JS server (`@langchain/langgraph-api`) and the managed server treat the
wire protocol differently: payloads the in-repo server normalizes before sending
are passed through strictly by the managed Python orchestrator. A change that
looks correct against the in-repo server can therefore still break graphs on the
managed runtime — and only this suite exercises that path.

## Layout

```
integration/
├── compose-postgres.yml   # Postgres (5433) + Redis (6380) + the built server image (9123)
├── graphs/                # the JS graph deployment under test
│   ├── *.ts               # agent, weather, nested, agent_simple, ... fixtures
│   ├── package.json       # deps; @langchain/langgraph tracks `latest` (see "Which JS code")
│   ├── configure-langgraph.py  # writes langgraph.json (generated, gitignored)
│   └── .env               # LANGGRAPH_CLOUD_LICENSE_KEY etc. (gitignored, never committed)
├── *.test.ts              # the suite: streaming, api, crons, background, multitasking
└── utils.ts
```

## Run

Prereqs: Docker, `uv` + the `langgraph` CLI (for `langgraph build`), and a
`LANGGRAPH_CLOUD_LICENSE_KEY` in your environment (the managed server image is
licensed). Never commit it — it is referenced by name only and injected at
runtime via `compose-postgres.yml` (`${LANGGRAPH_CLOUD_LICENSE_KEY}`).

```bash
cd integration
echo "LANGGRAPH_CLOUD_LICENSE_KEY=$LANGGRAPH_CLOUD_LICENSE_KEY" > graphs/.env   # local only; gitignored

pnpm install
pnpm int          # configure -> langgraph build -> compose up --wait -> vitest -> compose down
# or step by step:
pnpm configure    # graphs/configure-langgraph.py -> graphs/langgraph.json
pnpm build        # langgraph build --tag langgraphjs-tests-api  (yarn-installs graphs/, bundles into the server image)
pnpm up           # docker compose up --wait  (server on http://localhost:9123)
pnpm test         # vitest run  (SDK client hits :9123)
pnpm down
```

## Which JS code is under test

`graphs/package.json` pins `@langchain/langgraph` to `latest` by default, so the
suite runs the **published** JS against the managed server — the analog of how
the Python `sdk-py/integration` framework tracks `latest`.

To test **in-repo / unreleased** code (catching a regression before it ships —
the analog of Python's force-reinstall of the local core), inject a local build
before `pnpm build`:

```bash
# from the repo root, pack the workspace packages, then point graphs/ at the tarballs:
pnpm --filter @langchain/langgraph build && pnpm --filter @langchain/langgraph pack --pack-destination integration/graphs/vendor
# then set graphs/package.json:  "@langchain/langgraph": "file:./vendor/langchain-langgraph-<version>.tgz"
```

(`vendor/` is gitignored.) A nightly job would instead point `@langchain/langgraph`
at `next`/the nightly tag and the server image at the nightly `langgraph-api`
tag.
