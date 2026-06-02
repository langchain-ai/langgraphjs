# Review Setup

This Oracle persistence work lives inside a forked `langgraphjs` monorepo, not
as a standalone package checkout. Please review and test it by pulling the full
fork/branch, then running commands from the repository root.

## Pull The Branch

Branch to review:

```txt
research/oracledb-langgraph-plan
```

Package browser links:

- GitLab: https://linux-git.oraclecorp.com/ddhok/langgraphjs/-/tree/research/oracledb-langgraph-plan/libs/checkpoint-oracledb?ref_type=heads
- GitHub: https://github.com/Devx228/langgraphjs/tree/research/oracledb-langgraph-plan/libs/checkpoint-oracledb

The links above point directly to the package, but please clone/pull the whole
`langgraphjs` fork because this package depends on local workspace packages.

If using GitHub:

```sh
git clone https://github.com/Devx228/langgraphjs.git
cd langgraphjs
git checkout research/oracledb-langgraph-plan
```

If the repo is already cloned:

```sh
git fetch origin
git checkout research/oracledb-langgraph-plan
git pull
```

If using the Oracle GitLab mirror:

```sh
git clone https://linux-git.oraclecorp.com/ddhok/langgraphjs.git
cd langgraphjs
git checkout research/oracledb-langgraph-plan
```

The GitLab clone URL may require Oracle network access and GitLab
authentication. If HTTPS clone is not enabled for your account, use the clone
URL shown by GitLab for the same repository and then check out the branch above.

## Why Pull The Whole Fork

The implementation is in `libs/checkpoint-oracledb`, but it depends on the
workspace packages in this monorepo, especially:

```txt
libs/checkpoint
libs/checkpoint-validation
libs/langgraph-core
```

So the safest review path is to pull the complete forked branch and run the
package commands through `pnpm --filter`.

## Main Review Scope

Primary package:

```txt
libs/checkpoint-oracledb
```

Important files:

```txt
libs/checkpoint-oracledb/src/saver.ts
libs/checkpoint-oracledb/src/store.ts
libs/checkpoint-oracledb/src/sql.ts
libs/checkpoint-oracledb/src/migrations.ts
libs/checkpoint-oracledb/src/store-migrations.ts
libs/checkpoint-oracledb/src/index.ts
libs/checkpoint-oracledb/src/tests/
libs/checkpoint-oracledb/README.md
```

Base interfaces used for comparison:

```txt
libs/checkpoint/src/base.ts
libs/checkpoint/src/store/base.ts
libs/checkpoint/src/store/memory.ts
libs/checkpoint-validation/src/spec/
```

## Install

Required:

- Node.js 18 or newer
- pnpm
- Oracle Database credentials only for integration tests

From the repository root:

```sh
corepack enable
pnpm install
```

## Quick Verification Without Oracle

These commands do not require Oracle credentials:

```sh
pnpm --filter @oracle/langgraph-oracledb exec tsc --noEmit
pnpm --filter @oracle/langgraph-oracledb test
pnpm --filter @oracle/langgraph-oracledb run lint:dpdm
```

Expected coverage:

- TypeScript compile check
- unit tests for SQL helpers and saver setup/race handling
- circular dependency check

## Oracle Integration Tests

Set credentials first:

```sh
export ORACLE_USER="<user>"
export ORACLE_PASSWORD="<password>"
export ORACLE_CONNECT_STRING="<host>:<port>/<service>"
```

Then run:

```sh
pnpm --filter @oracle/langgraph-oracledb test:int
```

This validates:

- `OracleCheckpointSaver` against the shared LangGraph checkpoint-validation
  suite
- `OracleStore` against BaseStore-style behavior
- Oracle table setup and migrations
- checkpoint writes, pending writes, metadata filters, namespace handling, and
  thread deletion
- store put/get/search/delete/listNamespaces behavior
- optional Oracle VECTOR behavior when supported by the connected database

## Current Implementation Summary

Completed in this branch:

- `OracleCheckpointSaver` for durable LangGraph checkpoints
- `OracleStore` for long-term memory/store persistence
- Oracle migrations and table setup
- reversible checkpoint namespace encoding
- encoded store keys, including empty key support
- pending writes and legacy pending-send handling
- metadata/store filters with Oracle-safe SQL pushdown and JS fallback
- optional Oracle VECTOR search support
- integration tests and validation coverage

## Review Areas Where Feedback Would Help

- final package name and upstream naming convention
- CI strategy for Oracle integration tests
- Oracle VECTOR implementation approach and whether native vector binds/indexes
  should be added now or later
- performance expectations for complex store filters and wildcard namespace
  listing, which can fall back to broader scans for correctness
- package/workspace/lockfile cleanup needed before an upstream PR

## Notes

The draft PR can remain closed if preferred. The branch itself is enough for a
code review as long as the reviewer pulls the full fork and checks out the
correct branch.
