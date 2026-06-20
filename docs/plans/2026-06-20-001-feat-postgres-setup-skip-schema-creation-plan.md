---
title: "feat: Optional schema creation in Postgres setup()"
type: feat
status: active
date: 2026-06-20
---

# feat: Optional schema creation in Postgres setup()

## Overview

`PostgresSaver.setup()` (and `PostgresStore.setup()` via `runStoreMigrations`)
unconditionally run `CREATE SCHEMA IF NOT EXISTS "<schema>"` before applying
migrations. In locked-down enterprise environments the database role used by the
application is not permitted to create schemas — the schema is provisioned
out-of-band by a DBA. Today such users cannot complete setup without a
permission error, even when the target schema already exists and the role *can*
create tables inside it.

This change adds an opt-in **constructor option**, `createSchema` (default
`true`), that switches setup from "create the schema if missing" to "verify the
schema exists, fail clearly if not, then proceed with table migrations." Default
behavior is unchanged.

## Problem Frame

- The DDL `CREATE SCHEMA IF NOT EXISTS` requires the `CREATE` privilege on the
  database, which least-privilege roles often lack.
- Migrations create *tables* inside the schema, a separate and commonly-granted
  privilege. The only blocking statement is the `CREATE SCHEMA`.
- Users want to keep the rest of setup (migration bootstrapping) intact — only
  skip the schema-creation DDL and instead assert the schema is present.
- Whether the role can create schemas is an **environment property** that is
  fixed for the life of the connection, not something that varies per call.
  This is what makes a constructor option (rather than a per-call `setup()`
  argument) the right altitude.

## Requirements Trace

- R1. A constructor-level flag controls whether the schema is created during setup.
- R2. When the flag disables creation and the schema **exists**, setup proceeds
  normally (runs migrations / creates tables) without issuing `CREATE SCHEMA`.
- R3. When the flag disables creation and the schema **does not exist**, setup
  fails fast with a clear, actionable error naming the missing schema.
- R4. Default behavior is unchanged: existing callers (and all internal
  auto-`setup()` calls) keep getting `CREATE SCHEMA IF NOT EXISTS`.
- R5. The capability is available on both `PostgresSaver` and `PostgresStore`.
- R6. For `PostgresStore`, the store's internal lazy auto-`setup()` calls honor
  the flag (this is the key reason for choosing constructor delivery — a
  per-call `setup()` argument could not reach those internal callers).

## Scope Boundaries

- No change to migration contents, table DDL, or any non-setup method.
- No change to how the `schema` name itself is configured (existing `schema`
  option, default `"public"`).
- No per-call `setup()` argument — delivery is constructor-only (decided).
  Schema-creation privilege does not vary call-to-call, so per-call override has
  no real use case.
- Not introducing a new custom error class — this package does not depend on
  `BaseLangGraphError` (that lives in `@langchain/langgraph`, not a dependency of
  the checkpoint packages). A plain `Error` with a descriptive message matches
  the existing convention in this package.

## Context & Research

### Relevant Code and Patterns

- `libs/checkpoint-postgres/src/index.ts` — `PostgresSaverOptions`
  (`{ schema }`, ~26) and its `_ensureCompleteOptions` defaulting helper (~34),
  plus `PostgresSaver.setup()` (~134–176). The `CREATE SCHEMA IF NOT EXISTS` is
  the first statement in the `try` block; everything after is migration
  bootstrapping that should be preserved. `createSchema` belongs alongside
  `schema` in `PostgresSaverOptions`.
- `libs/checkpoint-postgres/src/store/modules/types.ts` — `PostgresStoreConfig`
  (~183) already declares `schema?` (~206) and `ensureTables?` (~212).
  `createSchema?: boolean` belongs right next to them.
- `libs/checkpoint-postgres/src/store/index.ts` — constructor (~57) reads
  `config.schema` and `config.ensureTables ?? true` (~80); `runStoreMigrations`
  (~215) runs `CREATE SCHEMA IF NOT EXISTS "${this.core.schema}"` (~220). The
  many `if (!this.isSetup && this.ensureTables) await this.setup()` call sites
  will all transparently honor a constructor-level `createSchema`.
- `libs/checkpoint-postgres/src/sql.ts` — already exports `tableExistsSQL(schema, table)`
  (~130) querying `information_schema.tables`. A parallel `schemaExistsSQL(schema)`
  querying `information_schema.schemata` is the natural home for the existence
  check and mirrors the established style.
- `libs/checkpoint-postgres/src/tests/sql.test.ts` — `describe("tableExistsSQL")`
  (~133) shows the unit-test pattern for SQL-builder helpers.

### Institutional Learnings

- No matching entries found in `docs/solutions/`.

### External References

- None required. Fully grounded in existing local patterns (`tableExistsSQL`, the
  `schema`/`ensureTables` option conventions, the setup migration flow).
  `information_schema.schemata` is standard Postgres catalog usage.

## Key Technical Decisions

- **Flag delivery: constructor option, not a `setup()` argument** (decided).
  - `PostgresSaver`: add `createSchema?: boolean` to `PostgresSaverOptions`,
    defaulted in `_ensureCompleteOptions` to `true`; `setup()` reads
    `this.options.createSchema`.
  - `PostgresStore`: add `createSchema?: boolean` to `PostgresStoreConfig`,
    defaulted in the constructor to `true`; `runStoreMigrations` reads it.
  - Rationale: pairs with the existing `schema` option; matches the environment
    nature of the privilege; and lets the store's internal auto-setup honor it
    (R6) — which a per-call argument could not do.
- **`createSchema` naming.** Reads naturally next to `schema`
  (`{ schema: "app", createSchema: false }`) and is unambiguous about what is
  skipped.
- **Behavior split.** When `createSchema !== false`: keep current
  `CREATE SCHEMA IF NOT EXISTS` and skip the existence check. When
  `createSchema === false`: skip `CREATE SCHEMA`, run the existence check, throw
  if absent, otherwise continue to migrations unchanged.
- **Existence check via a new `schemaExistsSQL` helper** in `sql.ts` mirroring
  `tableExistsSQL`, returning `SELECT EXISTS(... information_schema.schemata
  WHERE schema_name = '<schema>')`. Read `result.rows[0].exists`.
- **Error shape: plain `Error`** naming the schema and the cause (that the
  schema was expected to already exist because `createSchema: false` was set).

## Open Questions

### Resolved During Planning

- API mechanism — **constructor option** on both `PostgresSaverOptions` and
  `PostgresStoreConfig` (user decision; supersedes earlier `setup()`-argument
  direction).
- Store parity — apply to both `PostgresSaver` and `PostgresStore` (user decision).
- Store auto-setup honoring the flag — resolved by constructor delivery (R6).
- Error type — plain `Error`; `BaseLangGraphError` is not available in this package.

### Deferred to Implementation

- Exact wording of the thrown error message — finalize so it is actionable
  (name the schema, hint at provisioning it or omitting `createSchema: false`).
- Whether `schemaExistsSQL` should be parameterized rather than
  string-interpolated — default: mirror the existing `tableExistsSQL` style.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

Decision matrix for the branch at the top of `setup()` /
`runStoreMigrations()`:

| `createSchema` | Schema exists in DB | Outcome |
|---|---|---|
| `true` (default) | yes | `CREATE SCHEMA IF NOT EXISTS` (no-op), then migrations — **unchanged** |
| `true` (default) | no | `CREATE SCHEMA IF NOT EXISTS` creates it, then migrations — **unchanged** |
| `false` | yes | skip `CREATE SCHEMA`; existence check passes; run migrations |
| `false` | no | skip `CREATE SCHEMA`; existence check fails; **throw clear Error**, no migrations |

Sketch of the replaced opening of the `try` block:

```
if (this.options.createSchema !== false) {
  CREATE SCHEMA IF NOT EXISTS "<schema>"
} else {
  exists = query(schemaExistsSQL(schema)).rows[0].exists
  if (!exists) throw Error("schema <schema> does not exist; ...")
}
// ...unchanged migration bootstrapping continues...
```

For `PostgresStore`, the same branch lives in `runStoreMigrations`, reading the
constructor-stored flag — so every lazy `await this.setup()` caller honors it
without further changes.

## Implementation Units

- [ ] **Unit 1: Add `schemaExistsSQL` helper**

**Goal:** Provide a reusable query builder that checks whether a schema exists.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `libs/checkpoint-postgres/src/sql.ts`
- Test: `libs/checkpoint-postgres/src/tests/sql.test.ts`

**Approach:**
- Add `export const schemaExistsSQL = (schema: string) => ...` returning
  `SELECT EXISTS ( SELECT FROM information_schema.schemata WHERE schema_name = '<schema>' );`.
- Mirror the structure and export style of the adjacent `tableExistsSQL`.

**Patterns to follow:**
- `tableExistsSQL` in `libs/checkpoint-postgres/src/sql.ts` (~130).

**Test scenarios:**
- Happy path: `schemaExistsSQL("my-schema")` returns a string containing
  `information_schema.schemata` and `schema_name = 'my-schema'`.
- Edge case: `schemaExistsSQL("public")` produces a well-formed query including
  `SELECT EXISTS`.

**Verification:**
- New unit test passes; generated SQL references `information_schema.schemata`
  and embeds the provided schema name.

- [ ] **Unit 2: `createSchema` option in `PostgresSaver`**

**Goal:** Let `PostgresSaver` optionally verify (instead of create) the schema.

**Requirements:** R1, R2, R3, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `libs/checkpoint-postgres/src/index.ts`
- Test: `libs/checkpoint-postgres/src/tests/checkpoints.int.test.ts`

**Approach:**
- Add `createSchema?: boolean` to `PostgresSaverOptions`; default it to `true`
  in `_ensureCompleteOptions` (alongside the existing `schema` default).
- In `setup()`, branch at the top of the `try` block on
  `this.options.createSchema`:
  - default/`true` → keep `CREATE SCHEMA IF NOT EXISTS "<schema>"` as today.
  - `false` → run `schemaExistsSQL(this.options.schema)`; if
    `result.rows[0].exists` is falsy, `throw new Error(...)` naming the schema;
    otherwise fall through to the unchanged migration logic.
- Update the class/`fromConnString`/`setup` JSDoc to document `createSchema`
  with a `{ schema, createSchema: false }` example.

**Patterns to follow:**
- Existing `PostgresSaverOptions` + `_ensureCompleteOptions` (~26–41) and the
  `setup()` body in `libs/checkpoint-postgres/src/index.ts`.

**Test scenarios:**
- Happy path (regression): a saver constructed without `createSchema` still
  creates schema + tables in a fresh database via `setup()`.
- Happy path: pre-create the schema out-of-band; a saver constructed with
  `createSchema: false` completes `setup()` and a `put`/`getTuple` round-trip works.
- Error path: `createSchema: false` against a non-existent schema →
  `await expect(saver.setup()).rejects.toThrow()` with the schema named.
- Integration: re-running `setup()` on an existing schema with
  `createSchema: false` is idempotent (no error).

**Verification:**
- Integration tests pass; default-path tests unchanged; no `CREATE SCHEMA` is
  issued when `createSchema: false`.

- [ ] **Unit 3: `createSchema` option in `PostgresStore`**

**Goal:** Mirror the capability on the store, honored by lazy auto-setup.

**Requirements:** R1, R2, R3, R4, R5, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `libs/checkpoint-postgres/src/store/modules/types.ts`
- Modify: `libs/checkpoint-postgres/src/store/index.ts`
- Test: `libs/checkpoint-postgres/src/tests/store.int.test.ts`

**Approach:**
- Add `createSchema?: boolean` to `PostgresStoreConfig` (next to `schema` /
  `ensureTables`), with JSDoc and `@default true`.
- In the store constructor, store the resolved value (`config.createSchema ?? true`)
  where `schema`/`ensureTables` are kept (the `core`/instance fields).
- In `runStoreMigrations`, apply the same branch around the
  `CREATE SCHEMA IF NOT EXISTS "<schema>"` statement (~220) using
  `schemaExistsSQL`, reading the stored flag.
- No changes needed at the many `await this.setup()` call sites — they
  transparently honor the constructor flag (R6).

**Patterns to follow:**
- `config.ensureTables ?? true` resolution in the store constructor (~80);
  match Unit 2's branch for consistency.

**Test scenarios:**
- Happy path (regression): a store constructed without `createSchema` still
  provisions schema + store tables (existing behavior, incl. lazy auto-setup).
- Happy path: pre-create the schema; a store constructed with
  `createSchema: false` completes setup and a `put`/`get` item round-trip works.
- Error path: `createSchema: false` against a missing schema rejects with an
  error naming the schema.
- Integration (R6): with `createSchema: false` and `ensureTables: true` against
  an existing schema, a lazy operation (e.g. `get`/`put` without an explicit
  `setup()` call) triggers auto-setup that does **not** issue `CREATE SCHEMA`
  and succeeds.

**Verification:**
- Store integration tests pass; default path unchanged; lazy auto-setup honors
  `createSchema: false` end-to-end against an existing schema.

## System-Wide Impact

- **Interaction graph:** `PostgresSaver.setup()` is user-invoked only.
  `PostgresStore` auto-calls `setup()` from many read/write methods; with
  constructor delivery, all of them honor `createSchema` — the earlier
  auto-setup gap is closed.
- **API surface parity:** Both `PostgresSaverOptions` and `PostgresStoreConfig`
  gain an optional `createSchema` field; both stay backward compatible (optional,
  default preserves old behavior). No method signatures change.
- **Error propagation:** New failure mode is a `throw` inside setup before any
  migration runs, surfaced as a rejected promise — no partial schema/table state
  on the failure path.
- **Unchanged invariants:** Migration contents, table DDL, the `schema` option
  and its `"public"` default, `ensureTables` semantics, and all non-setup methods
  are untouched. Constructing without `createSchema` is equivalent to today.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `information_schema.schemata` visibility depends on the role's privileges; a role might not see a schema it lacks `USAGE` on, producing a false "does not exist". | Acceptable: if the role cannot see/use the schema, failing fast is the correct outcome. Error message should hint at privileges/provisioning. |
| Schema name string-interpolated into the existence query (matching `tableExistsSQL`). | Mirrors existing in-package convention; schema is developer-supplied config, not end-user input. Parameterization noted as optional hardening (deferred). |
| Two slightly different option-resolution sites (`_ensureCompleteOptions` for the saver, constructor for the store). | Keep the default (`true`) and branch logic identical in both; cross-reference in code comments so they stay in sync. |

## Documentation / Operational Notes

- Update JSDoc in `index.ts` (class + `fromConnString` + `setup`) and the
  `PostgresStoreConfig` field doc to document `createSchema` with a
  `{ schema, createSchema: false }` example.
- No migration or rollout concerns — purely additive, backward-compatible.

## Sources & References

- Related code: `libs/checkpoint-postgres/src/index.ts` (`PostgresSaverOptions`,
  `_ensureCompleteOptions`, `setup`), `libs/checkpoint-postgres/src/store/index.ts`
  (constructor, `runStoreMigrations`),
  `libs/checkpoint-postgres/src/store/modules/types.ts` (`PostgresStoreConfig`),
  `libs/checkpoint-postgres/src/sql.ts` (`tableExistsSQL`).
- Related tests: `libs/checkpoint-postgres/src/tests/sql.test.ts`,
  `libs/checkpoint-postgres/src/tests/checkpoints.int.test.ts`,
  `libs/checkpoint-postgres/src/tests/store.int.test.ts`.
