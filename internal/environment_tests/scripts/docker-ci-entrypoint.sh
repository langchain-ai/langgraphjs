#!/usr/bin/env bash

set -euxo pipefail

export CI=true

# TypeScript in these export tests can use a lot of memory in CI; raise the heap limit
# to avoid sporadic OOM failures on GitHub runners.
export NODE_OPTIONS="--max-old-space-size=6144 ${NODE_OPTIONS:-}"

# Enable corepack to use pnpm
corepack enable
corepack prepare pnpm@10.27.0 --activate

# Copy package files (explicitly to avoid glob issues)
cp ../package/package.json .
cp ../package/pnpm-workspace.yaml . 2>/dev/null || true
cp ../package/tsconfig.json . 2>/dev/null || true
cp -r ../package/src . 2>/dev/null || true
cp -r ../package/public . 2>/dev/null || true

# Copy hidden files, suppressing errors if no matches are found
cp ../package/.[!.]* . 2>/dev/null || true

# Copy workspace packages
mkdir -p ./libs/langgraph/
mkdir -p ./libs/langgraph-core/
mkdir -p ./libs/checkpoint/
mkdir -p ./libs/sdk/

cp -r ../langgraph ./libs/
cp -r ../langgraph-core ./libs/
cp -r ../checkpoint ./libs/
cp -r ../sdk ./libs/

# Debug: show workspace structure
echo "=== Workspace packages ==="
ls -la libs/
for pkg in libs/*/; do
  if [ -f "$pkg/package.json" ]; then
    echo "$pkg: $(grep -o '"name": "[^"]*"' "$pkg/package.json" | head -1)"
  fi
done

# Install dependencies (without frozen-lockfile since each test env has its own deps)
pnpm install

# Check the build command completes successfully
pnpm build

# Check the test command completes successfully
pnpm test
