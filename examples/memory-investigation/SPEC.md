# Memory MRE Spec

## Goal

Replace the current `examples/memory-investigation/` directory with a clean, minimal reproduction of memory growth under load. The new setup must:

1. Run **deepagents** against a locally-built `@langchain/langgraph` so we can A/B test patches
2. Use **real LLM API calls** (Haiku — cheap, fast, realistic memory behavior)
3. Include a **load generator** that ramps concurrency until failure (OOM / timeout / error rate threshold), reporting telemetry at each ramp event
4. Collect **container-level stats** (Docker `stats` API) alongside application-level metrics
5. Produce JSONL that feeds a **Jupyter notebook** for visualization
6. Be self-contained — one `docker compose up` to start, one command to drive load

## Non-goals

- Diagnosing *which* allocation is dominant (the existing FINDINGS.md already did this — per-tick working set, not retention)
- Profiling or heap snapshot automation (can be added later via the `/admin/heapsnapshot` pattern)
- Deterministic replay (the old investigation proved the findings; now we need real-world memory behavior under real API latency patterns)

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Container: mre-service (Node.js, mem_limit: 1GB)    │
│                                                      │
│  deepagents + local @langchain/langgraph             │
│  ┌───────────┐   ┌──────────────┐                    │
│  │ Hono HTTP │──▶│ deepagents   │                    │
│  │ /run      │   │ .stream()    │                    │
│  │ /health   │   │ (Haiku LLM)  │                    │
│  │ /metrics  │   └──────────────┘                    │
│  └───────────┘                                       │
│                                                      │
│  Telemetry: periodic memoryUsage() to stdout (JSONL) │
└──────────────────────────────────────────────────────┘
         ▲                              ▲
         │ HTTP                         │ Docker API
         │                              │ (/containers/{id}/stats)
┌────────┴──────────────────────────────┴──────────────┐
│  loadgen (runs on host)                              │
│                                                      │
│  ┌──────────┐  ┌────────────────┐  ┌──────────────┐ │
│  │ Ramp     │  │ Docker stats   │  │ /metrics     │ │
│  │ driver   │  │ poller         │  │ poller       │ │
│  │ C=1→2→…  │  │ (200ms)        │  │ (200ms)      │ │
│  └────┬─────┘  └───────┬────────┘  └──────┬───────┘ │
│       └────────────────┴───────────────────┘         │
│                        │                             │
│                   JSONL file                          │
└──────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────┐
│  analysis.ipynb     │
│  (Jupyter notebook) │
│  reads JSONL,       │
│  plots memory       │
│  curves, ramp       │
│  events, A/B diffs  │
└─────────────────────┘
```

## Components

### 1. Service (`service/`)

Minimal Hono HTTP server. Endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness probe + RSS/heap glance |
| `GET` | `/metrics` | Full `process.memoryUsage()` + `v8.getHeapStatistics()` |
| `POST` | `/run` | SSE stream — pipes deepagents output directly to the client |

The `/run` endpoint:
- Creates a deepagents agent with `ChatAnthropic` (model: `claude-haiku-3` or whatever is cheapest at the time, configurable via env var `MODEL_NAME`)
- Uses a fixed prompt that triggers the parallel subagent fan-out pattern (the same supervisor + N research subagents topology the customer uses)
- Calls `.stream()` with `streamMode: ["messages", "values"], subgraphs: true, encoding: "text/event-stream"` (the customer's config)
- **Pipes the SSE ReadableStream directly into the HTTP Response** — chunks flow over the wire as they're produced, exercising the real backpressure path where the Pregel engine's stream queue fills while bytes are flushed to the network
- GCs between requests (`global.gc()` via `--expose-gc`)
- Memory stats are collected by the `/metrics` poller, not from the `/run` response (which is a pure SSE byte stream)

The prompt should be short but reliably trigger fan-out. Something like:
> "Research the top 3 programming languages by popularity in 2025. For each, find its creator, year created, and one unique feature. Return a summary table."

This naturally triggers the supervisor to dispatch 3+ parallel research subagents, each making multiple LLM calls. Haiku will respond quickly (~1-3s per call), keeping the per-request wall time reasonable (~10-30s) while still exercising the full streaming/subgraph/fan-out path.

Telemetry: a background sampler emits `process.memoryUsage()` every 100ms to stdout as JSONL. Each `/run` request also emits start/end events with memory snapshots.

### 2. Dockerfile

Multi-stage build:

```
Stage 1: build langgraphjs from source
  - Copy langgraphjs repo
  - pnpm install && pnpm build
  - Output: built dist/ for @langchain/langgraph, checkpoint, sdk

Stage 2: build the MRE service
  - Copy service source
  - Install deps with pnpm overrides pointing @langchain/langgraph
    to the stage-1 build output
  - Output: runnable service

Stage 3: runtime
  - node:22-slim
  - Copy built service + node_modules
  - CMD: node --expose-gc --max-old-space-size=768 dist/server.js
```

The container gets `mem_limit: 1g` in docker-compose. `--max-old-space-size=768` gives V8 a 768MB heap ceiling inside that, leaving room for RSS overhead (stacks, native buffers, mmap).

The key property: the container uses the *locally built* langgraph, not the npm registry version. To test a patch, rebuild the image.

### 3. docker-compose.yml

```yaml
services:
  mre-service:
    build:
      context: ../../          # langgraphjs repo root (for stage 1)
      dockerfile: examples/memory-investigation/service/Dockerfile
    ports:
      - "3000:3000"
    mem_limit: 1g
    memswap_limit: 1g         # no swap — OOM kill is the signal
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - MODEL_NAME=${MODEL_NAME:-claude-haiku-3}
      - NODE_OPTIONS=--expose-gc --max-old-space-size=768
    volumes:
      - ./results:/results     # for heap snapshots if needed
```

### 4. Load generator (`loadgen/ramp.ts`)

A standalone TypeScript script (runs on the host, not in the container). Three concurrent activities:

**a) Ramp driver** — fires requests at escalating concurrency

```
npx tsx loadgen/ramp.ts \
  --base http://localhost:3000 \
  --container mre-service \
  --requests-per-level 4 \
  --cooldown 15 \
  --max-concurrency 16 \
  --out results/ramp-$(date +%s).jsonl
```

Ramp strategy: starts at concurrency=1, doubles each level (1 → 2 → 4 → 8 → 16). At each level, fires `requests-per-level` requests at that concurrency. Between levels, pauses for `cooldown` seconds so the container's memory can settle (V8 sometimes holds expanded heap capacity briefly after a burst).

Stop conditions (any of):
- Container returns non-200 on `/run`
- Container stops responding to `/health` (OOM killed)
- Error rate at a level exceeds 50%
- Max concurrency reached

**b) Docker stats poller** — reads container-level memory via Docker API

Uses the Docker Engine API (`/containers/{name}/stats?stream=false`) every 200ms to capture:
- `memory_stats.usage` — total container memory (RSS + cache + swap)
- `memory_stats.limit` — the `mem_limit` ceiling
- `memory_stats.stats.rss` — actual RSS within the cgroup
- `memory_stats.max_usage` — high-water mark since container start
- CPU usage (for correlation)

This is the *external* view of memory — what a k8s OOM killer or Docker daemon sees. It doesn't depend on the Node process reporting anything, so it works even when the process is GC-stalled or wedged.

The poller can use either:
- `docker stats --no-stream --format json` via child_process (simplest)
- The Docker socket directly (`/var/run/docker.sock`) for lower overhead

**c) App metrics poller** — hits `/metrics` on the service every 200ms

This is the *internal* view — `process.memoryUsage()` + V8 heap stats. Complements the Docker stats with heap-specific detail (heap_used vs heap_total, external, array_buffers).

Both pollers write to the same JSONL output file, interleaved by timestamp.

### 5. JSONL event schema

All events share `{ "ev": string, "t": number }` (event type + wall-clock ms).

```jsonc
// ── Ramp lifecycle ──
{ "ev": "ramp_start", "t": 1234, "config": { "base": "...", "max_concurrency": 16, ... } }
{ "ev": "level_start", "t": 1234, "concurrency": 4, "level_idx": 2 }
{ "ev": "level_end", "t": 1234, "concurrency": 4, "requests": 4, "ok": 3, "failed": 1, "duration_ms": 45000 }
{ "ev": "cooldown_start", "t": 1234, "after_concurrency": 4 }
{ "ev": "cooldown_end", "t": 1234 }
{ "ev": "ramp_stop", "t": 1234, "reason": "oom_killed | error_rate | max_reached", "last_concurrency": 8 }

// ── Per-request (SSE stream consumed by load generator) ──
{ "ev": "request_start", "t": 1234, "concurrency": 4, "request_idx": 12 }
{ "ev": "request_end", "t": 1234, "concurrency": 4, "request_idx": 12,
  "ok": true, "duration_ms": 12500,
  "sse_events": 340, "sse_bytes": 128000 }

// ── Docker container stats (external view) ──
{ "ev": "docker_stats", "t": 1234,
  "container_mem_usage_mb": 520,
  "container_mem_limit_mb": 1024,
  "container_mem_pct": 50.8,
  "container_rss_mb": 490,
  "container_mem_max_usage_mb": 610,
  "container_cpu_pct": 85.2 }

// ── App metrics (internal view, from /metrics endpoint) ──
{ "ev": "app_metrics", "t": 1234,
  "rss": 210000000, "heap_used": 95000000, "heap_total": 130000000,
  "external": 5000000, "array_buffers": 2000000 }
```

### 6. Jupyter notebook (`analysis.ipynb`)

Reads one or two JSONL files and produces:

**Single-run plots:**
- **Memory timeline** — overlaid lines for container RSS (docker_stats), app RSS (app_metrics), heap_used, heap_total. X-axis is wall time. Vertical bands show ramp level transitions (colored by concurrency). Red vertical line at OOM/failure.
- **Per-request scatter** — peak_heap_mb vs request_idx, colored by concurrency level. Shows whether peak scales with concurrency.
- **Request latency distribution** — box plot per concurrency level.
- **Container memory utilization** — `container_mem_usage / container_mem_limit` as a line, with a horizontal red line at 100%.

**A/B comparison plots** (when two files are loaded):
- Side-by-side memory timelines (baseline vs patched)
- Delta table: per-level peak heap, peak RSS, p50/p95 latency
- "How much further did it get" — which concurrency level each run failed at

The notebook uses pandas for JSONL parsing and matplotlib/plotly for plots. Cells are structured so you set two variables at the top (`RUN_A = "results/baseline.jsonl"`, `RUN_B = "results/patched.jsonl"`) and run all.

## What to delete

Everything in `examples/memory-investigation/` except:

- `service/src/agent-setup.ts` (deepagents agent factory — reuse, update to use real model)
- `service/src/telemetry.ts` (memory sampling — reuse as-is)

Delete:

- `experiments/` (all experiment directories — findings captured in FINDINGS.md)
- `snapshots/` (heap snapshot files)
- `results/` (old result files)
- `tools/` (one-off Python analysis)
- `loadgen/drive.ts` (replaced by `ramp.ts`)
- `loadgen/analyze.py`, `loadgen/analyze-sweep.py` (replaced by notebook)
- `instrument-langgraph.sh` (no longer needed — Dockerfile builds from source)
- `service/src/scripted-model.ts` (replaced by real API calls)
- `service/src/replay.ts` (replay infrastructure)
- `service/src/traces/` (trace fixtures for replay)
- `service/src/fixtures/` (prompt fixtures — replaced by inline prompt)
- `service/docker/` (old docker config)
- `FINDINGS.md` (archive to repo wiki or `docs/` — not part of the MRE)

## Directory structure (after cleanup)

```
examples/memory-investigation/
├── SPEC.md                      ← this file
├── docker-compose.yml
├── .env.example                 ← ANTHROPIC_API_KEY=sk-ant-...
├── package.json
├── tsconfig.json
├── service/
│   ├── Dockerfile
│   └── src/
│       ├── server.ts            ← Hono service (simplified)
│       ├── runner.ts            ← deepagents invocation wrapper
│       ├── agent-setup.ts       ← agent factory (reused, updated for real model)
│       └── telemetry.ts         ← memory sampling (reused)
├── loadgen/
│   └── ramp.ts                  ← ramp-to-failure driver + docker stats + app metrics pollers
├── analysis.ipynb               ← Jupyter notebook for visualization
└── results/                     ← gitignored, populated by runs
```

## How to use

```bash
# 1. Set up credentials
cp .env.example .env
# edit .env to add ANTHROPIC_API_KEY

# 2. Build (includes local langgraph from source)
docker compose build

# 3. Start service
docker compose up -d

# 4. Run ramp-to-failure
npx tsx loadgen/ramp.ts \
  --base http://localhost:3000 \
  --container mre-service \
  --out results/baseline.jsonl

# 5. Visualize
jupyter notebook analysis.ipynb

# 6. A/B test a patch
#    (make changes to langgraph source)
docker compose build && docker compose up -d
npx tsx loadgen/ramp.ts \
  --base http://localhost:3000 \
  --container mre-service \
  --out results/patched.jsonl
#    (set RUN_B in notebook, re-run cells)
```

## Success criteria

The MRE is done when:
1. `docker compose up` starts the service with only `ANTHROPIC_API_KEY` required
2. `loadgen/ramp.ts` drives load until failure and produces a JSONL trace with docker stats
3. `analysis.ipynb` renders memory timelines, per-request scatter, and latency distributions from the trace
4. Rebuilding after a langgraph patch and re-running shows measurable differences in the notebook's A/B comparison
5. The container OOMs or degrades at a reproducible concurrency level (within ~1 level across runs)
