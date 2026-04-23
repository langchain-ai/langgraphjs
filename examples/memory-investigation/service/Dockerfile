# Memory MRE service — builds @langchain/langgraph from source so we
# can A/B test patches by rebuilding the image.
#
# Build context: langgraphjs repo root (../../ from this file).
#   docker compose build      (from examples/memory-investigation/)

# ── Stage 1: build langgraphjs from source ──────────────────────────
FROM node:22-slim AS lg-builder
WORKDIR /langgraphjs

RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

# Copy the full repo — turbo needs the workspace structure, turbo.json,
# root package.json, and all libs/ to resolve workspace: dependencies.
# This is a build-only stage; nothing here makes it into the runtime image.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY libs/ libs/
COPY internal/ internal/

# Install workspace deps and build
RUN pnpm install --frozen-lockfile --ignore-scripts 2>/dev/null || pnpm install --no-frozen-lockfile --ignore-scripts

# Build only the packages the service needs (not vue/react/angular SDKs etc.)
RUN pnpm turbo run build:internal \
      --filter=@langchain/langgraph \
      --filter=@langchain/langgraph-checkpoint \
      --filter=@langchain/langgraph-sdk

# ── Stage 2: build the MRE service ──────────────────────────────────
FROM node:22-slim AS svc-builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

# Copy the built langgraph packages (dist/ + package.json for each)
COPY --from=lg-builder /langgraphjs/libs/langgraph-core/ /langgraph/langgraph-core/
COPY --from=lg-builder /langgraphjs/libs/checkpoint/ /langgraph/checkpoint/
COPY --from=lg-builder /langgraphjs/libs/sdk/ /langgraph/sdk/

# Service package.json with pnpm overrides pointing to local langgraph
COPY examples/memory-investigation/service/package.json ./package.json
RUN pnpm install --no-frozen-lockfile

# Copy service source
COPY examples/memory-investigation/service/src ./src

# ── Stage 3: runtime ────────────────────────────────────────────────
FROM node:22-slim
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.27.0 --activate && \
    npm install -g tsx

COPY --from=svc-builder /app/ /app/

RUN mkdir -p /results

ENV PORT=3000
EXPOSE 3000

CMD ["tsx", "src/server.ts"]
