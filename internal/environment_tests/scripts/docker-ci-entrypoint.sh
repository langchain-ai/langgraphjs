#!/usr/bin/env bash

set -euxo pipefail

export CI=true

# TypeScript in these export tests can use a lot of memory in CI; raise the heap limit
# to avoid sporadic OOM failures on GitHub runners.
export NODE_OPTIONS="--max-old-space-size=6144 ${NODE_OPTIONS:-}"

# Enable corepack to use pnpm
corepack enable
corepack prepare pnpm@10.27.0 --activate

# enable extended globbing for omitting build artifacts
shopt -s extglob

# avoid copying build artifacts from the host
cp -r ../package/!(node_modules|dist|dist-cjs|dist-esm|build|.next|.turbo) .

# Copy hidden files, suppressing errors if no matches are found
cp ../package/.[!.]* . 2>/dev/null || true

mkdir -p ./libs/langgraph/
mkdir -p ./libs/langgraph-core/
mkdir -p ./libs/checkpoint/
mkdir -p ./libs/sdk/

cp -r ../langgraph ./libs/
cp -r ../langgraph-core ./libs/
cp -r ../checkpoint ./libs/
cp -r ../sdk ./libs/

# Install dependencies (without frozen-lockfile since each test env has its own deps)
pnpm install

# Check the build command completes successfully
pnpm build

# Check the test command completes successfully
pnpm test
