#!/usr/bin/env bash
# Namespace-narrowing benchmark. Usage: run.sh <size>...
#
# By default this measures the working tree. Set BENCH_COMMITS to a list of
# revisions to compare instead -- store.ts is swapped to each in turn and
# restored on exit, including on failure.
#
#   ./run.sh 10000 100000
#   BENCH_COMMITS="origin/main HEAD" ./run.sh 100000
#
# Needs Redis 8 with RediSearch on BENCH_REDIS_URL (default redis://127.0.0.1:6399).
# The database is flushed and reseeded per run.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
P=libs/checkpoint-redis/src/store.ts
BENCH="./node_modules/.bin/tsx libs/checkpoint-redis/benchmarks/namespace-bench.ts"

if [ -z "${BENCH_COMMITS:-}" ]; then
  for size in "$@"; do
    BENCH_LABEL="working-tree" BENCH_SIZE="$size" $BENCH
  done
  exit 0
fi

git diff --quiet -- "$P" || {
  echo "refusing to swap $P with uncommitted changes" >&2
  exit 1
}
trap 'git checkout HEAD -- "$P"' EXIT
for c in $BENCH_COMMITS; do
  git checkout "$c" -- "$P"
  for size in "$@"; do
    BENCH_LABEL="$c" BENCH_SIZE="$size" $BENCH
  done
done
