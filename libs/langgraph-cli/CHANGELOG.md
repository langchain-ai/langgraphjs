# @langchain/langgraph-cli

## 1.4.2

### Patch Changes

- [#2590](https://github.com/langchain-ai/langgraphjs/pull/2590) [`f71e00c`](https://github.com/langchain-ai/langgraphjs/commit/f71e00c52600a6dafacccdde1363e83c17c8d97b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(api): inject langgraph_auth_user on protocol-v2 run.start

  Stamp authenticated user fields onto run config in createOrResumeRun so
  v2 streaming matches the REST runs API. Shared helpers also dedupe REST
  run config auth/header enrichment.

- [#2575](https://github.com/langchain-ai/langgraphjs/pull/2575) [`e1b40c2`](https://github.com/langchain-ai/langgraphjs/commit/e1b40c29e14f8e9fb2696acc62d611e14a813f43) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(cli): support node_version 24 in langgraph.json

  Allow Node 24 in the CLI config schema and Docker base image resolution.
  The langgraphjs-api:24 image is already published from langgraph-api.

- Updated dependencies [[`f71e00c`](https://github.com/langchain-ai/langgraphjs/commit/f71e00c52600a6dafacccdde1363e83c17c8d97b), [`e1b40c2`](https://github.com/langchain-ai/langgraphjs/commit/e1b40c29e14f8e9fb2696acc62d611e14a813f43)]:
  - @langchain/langgraph-api@1.4.2

## 1.4.1

### Patch Changes

- [#2568](https://github.com/langchain-ai/langgraphjs/pull/2568) [`38d15e2`](https://github.com/langchain-ai/langgraphjs/commit/38d15e2f1f9dded34665a602cd9311cbcf5fbefc) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph-api): support configurable TypeScript loaders in dev server

  Add `node_loader` to `langgraph.json` (and `LANGGRAPH_NODE_LOADER` env override) so projects using reflect-metadata can use `ts-node` (`--loader ts-node/esm`) instead of the default tsx CLI. Other loaders default to `--import`; only registered shorthands like `ts-node` use `--loader`. `--no-reload` now also disables tsx's internal watch mode. Closes [#1834](https://github.com/langchain-ai/langgraphjs/issues/1834).

- Updated dependencies [[`38d15e2`](https://github.com/langchain-ai/langgraphjs/commit/38d15e2f1f9dded34665a602cd9311cbcf5fbefc)]:
  - @langchain/langgraph-api@1.4.1

## 1.4.0

### Minor Changes

- [#2559](https://github.com/langchain-ai/langgraphjs/pull/2559) [`48cbdd2`](https://github.com/langchain-ai/langgraphjs/commit/48cbdd23fdf29277530f6aa05c397c9902e81206) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(langgraph-cli): add `deploy` command for LangSmith Deployment

  Port the Python CLI's `langgraph deploy` workflow to `@langchain/langgraph-cli`, including local and remote build paths, deployment lifecycle subcommands (`list`, `revisions list`, `delete`, `logs`), and host-backend client utilities with tests.

### Patch Changes

- Updated dependencies [[`48cbdd2`](https://github.com/langchain-ai/langgraphjs/commit/48cbdd23fdf29277530f6aa05c397c9902e81206), [`b1e856d`](https://github.com/langchain-ai/langgraphjs/commit/b1e856d987ac16148dc0872d1fecf70e659ef28e), [`b1e856d`](https://github.com/langchain-ai/langgraphjs/commit/b1e856d987ac16148dc0872d1fecf70e659ef28e)]:
  - @langchain/langgraph-api@1.4.0

## 1.3.1

### Patch Changes

- [#2527](https://github.com/langchain-ai/langgraphjs/pull/2527) [`9e114e5`](https://github.com/langchain-ai/langgraphjs/commit/9e114e55d362a874878a817740de42fd62ae9db7) Thanks [@christian-bromann](https://github.com/christian-bromann)! - chore(deps): remove uuid dependency in favor of embedded uuid in core

  Replace direct `uuid` package imports with `@langchain/core/utils/uuid` across
  langgraph packages to deduplicate dependencies and align with @langchain/core's
  embedded UUID utilities.

- Updated dependencies [[`9e114e5`](https://github.com/langchain-ai/langgraphjs/commit/9e114e55d362a874878a817740de42fd62ae9db7)]:
  - @langchain/langgraph-api@1.3.1

## 1.3.0

### Patch Changes

- Updated dependencies [[`cad31b4`](https://github.com/langchain-ai/langgraphjs/commit/cad31b42f001a87fcdf57c4c084c655c8762b6a5)]:
  - @langchain/langgraph-api@1.3.0

## 1.2.5

### Patch Changes

- Updated dependencies [[`658a076`](https://github.com/langchain-ai/langgraphjs/commit/658a076d5b50af9f5b96ab99f26ed629da6e182f)]:
  - @langchain/langgraph-api@1.2.5

## 1.2.4

### Patch Changes

- [#1925](https://github.com/langchain-ai/langgraphjs/pull/1925) [`6503319`](https://github.com/langchain-ai/langgraphjs/commit/65033191cc3dd671d64dfac78ccdad453fdfbda2) Thanks [@jbrody-nexxa](https://github.com/jbrody-nexxa)! - fix(cli): add --no-reload flag to dev command

- Updated dependencies [[`0125920`](https://github.com/langchain-ai/langgraphjs/commit/0125920a2c4a87dc1d66aaf541ea16146f8cf842)]:
  - @langchain/langgraph-api@1.2.4

## 1.2.3

### Patch Changes

- [#2443](https://github.com/langchain-ai/langgraphjs/pull/2443) [`80a8c12`](https://github.com/langchain-ai/langgraphjs/commit/80a8c1200a240fd984edc4deb26a7787d08c7532) Thanks [@christian-bromann](https://github.com/christian-bromann)! - refactor(sdk): drop StreamSubmitOptions.command and simplify forkFrom

  Remove the misleading submit({ command }) surface from protocol-v2
  StreamController; HITL resume is respond() only. Accept forkFrom as a
  plain checkpoint id string and align protocol-v2 servers and docs.

- Updated dependencies [[`80c2806`](https://github.com/langchain-ai/langgraphjs/commit/80c2806cb2da93745a640664bd0cf603c2361da9), [`80a8c12`](https://github.com/langchain-ai/langgraphjs/commit/80a8c1200a240fd984edc4deb26a7787d08c7532), [`2c14b12`](https://github.com/langchain-ai/langgraphjs/commit/2c14b12a80c306578563e77595943037c7c4844d)]:
  - @langchain/langgraph-api@1.2.3

## 1.2.2

### Patch Changes

- [#2389](https://github.com/langchain-ai/langgraphjs/pull/2389) [`40bcdab`](https://github.com/langchain-ai/langgraphjs/commit/40bcdab38fa495028d8eba68062e48079dbe9208) Thanks [@jdrogers940](https://github.com/jdrogers940)! - Adding support for pre-release versions in api_version.

- [#2396](https://github.com/langchain-ai/langgraphjs/pull/2396) [`9b20df0`](https://github.com/langchain-ai/langgraphjs/commit/9b20df081a82b79efca3dfd2c128243889b11eb8) Thanks [@hntrl](https://github.com/hntrl)! - fix(langgraph-cli): accept hyphenated prerelease tags in `api_version` values.

- Updated dependencies [[`9b20df0`](https://github.com/langchain-ai/langgraphjs/commit/9b20df081a82b79efca3dfd2c128243889b11eb8)]:
  - @langchain/langgraph-api@1.2.2

## 1.2.2-rc.0

### Patch Changes

- [#2389](https://github.com/langchain-ai/langgraphjs/pull/2389) [`40bcdab`](https://github.com/langchain-ai/langgraphjs/commit/40bcdab38fa495028d8eba68062e48079dbe9208) Thanks [@jdrogers940](https://github.com/jdrogers940)! - Adding support for pre-release versions in api_version.

- [#2396](https://github.com/langchain-ai/langgraphjs/pull/2396) [`9b20df0`](https://github.com/langchain-ai/langgraphjs/commit/9b20df081a82b79efca3dfd2c128243889b11eb8) Thanks [@hntrl](https://github.com/hntrl)! - fix(langgraph-cli): accept hyphenated prerelease tags in `api_version` values.

- Updated dependencies [[`9b20df0`](https://github.com/langchain-ai/langgraphjs/commit/9b20df081a82b79efca3dfd2c128243889b11eb8)]:
  - @langchain/langgraph-api@1.2.2-rc.0

## 1.2.1

### Patch Changes

- Updated dependencies [[`2bb66bf`](https://github.com/langchain-ai/langgraphjs/commit/2bb66bf816a8b18b2968ed885ef2df15f684cb4e)]:
  - @langchain/langgraph-api@1.2.1

## 1.2.0

### Patch Changes

- Updated dependencies [[`085a07f`](https://github.com/langchain-ai/langgraphjs/commit/085a07f569b6d7d79728eb7eb6eb3a0c67fcdefb)]:
  - @langchain/langgraph-api@1.2.0

## 1.1.17

### Patch Changes

- [#2247](https://github.com/langchain-ai/langgraphjs/pull/2247) [`9874420`](https://github.com/langchain-ai/langgraphjs/commit/9874420019199a7064501b53b9407bd23dc752f9) Thanks [@jdrogers940](https://github.com/jdrogers940)! - Respect when http config is set. Also don't log an error when .env file is missing.

- Updated dependencies []:
  - @langchain/langgraph-api@1.1.17

## 1.1.16

### Patch Changes

- [#2183](https://github.com/langchain-ai/langgraphjs/pull/2183) [`ad266cf`](https://github.com/langchain-ai/langgraphjs/commit/ad266cf29fc42000485aa77b6142f5729bc17c82) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(cli): allow --config to point to any config file

- Updated dependencies []:
  - @langchain/langgraph-api@1.1.16

## 1.1.15

### Patch Changes

- Updated dependencies [[`730b82d`](https://github.com/langchain-ai/langgraphjs/commit/730b82d2309e65e6b2ed99ebff2aa052cff8ed35)]:
  - @langchain/langgraph-api@1.1.15

## 1.1.14

### Patch Changes

- Updated dependencies [[`aa8e878`](https://github.com/langchain-ai/langgraphjs/commit/aa8e878e5b71128685ab7e7a79c96bd2519c0123)]:
  - @langchain/langgraph-api@1.1.14

## 2.0.0

### Patch Changes

- Updated dependencies []:
  - @langchain/langgraph-api@2.0.0

## 1.1.13

### Patch Changes

- [#1954](https://github.com/langchain-ai/langgraphjs/pull/1954) [`632d39f`](https://github.com/langchain-ai/langgraphjs/commit/632d39f5a1c6d0f838e48e5e59e580d5a82faa94) Thanks [@hinthornw](https://github.com/hinthornw)! - Support `api_version` field in `langgraph.json` to control the base Docker image tag. When set, the image tag becomes `{api_version}-node{node_version}` (e.g., `langchain/langgraphjs-api:0.7.29-node22`) instead of just `{node_version}`.

- Updated dependencies [[`4ebe31e`](https://github.com/langchain-ai/langgraphjs/commit/4ebe31ec6ea289f2eeff324fb1875af869d543c9)]:
  - @langchain/langgraph-api@1.1.13

## 1.1.12

### Patch Changes

- Updated dependencies [[`ad39dcf`](https://github.com/langchain-ai/langgraphjs/commit/ad39dcfddf575a5e5438cd40b284ac0d549b5827)]:
  - @langchain/langgraph-api@1.1.12

## 1.1.11

### Patch Changes

- Updated dependencies [[`2b9f3ee`](https://github.com/langchain-ai/langgraphjs/commit/2b9f3ee83d0b8ba023e7a52b938260af3f6433d4)]:
  - @langchain/langgraph-api@1.1.11

## 1.1.10

### Patch Changes

- Updated dependencies [[`e7aeffe`](https://github.com/langchain-ai/langgraphjs/commit/e7aeffeb72aaccd8c94f8e78708f747ce21bf23c), [`e7aeffe`](https://github.com/langchain-ai/langgraphjs/commit/e7aeffeb72aaccd8c94f8e78708f747ce21bf23c)]:
  - @langchain/langgraph-api@1.1.10
  - create-langgraph@1.1.5

## 1.1.9

### Patch Changes

- Updated dependencies [[`a9fa28b`](https://github.com/langchain-ai/langgraphjs/commit/a9fa28b6adad16050fcf5d5876a3924253664217), [`a9fa28b`](https://github.com/langchain-ai/langgraphjs/commit/a9fa28b6adad16050fcf5d5876a3924253664217)]:
  - @langchain/langgraph-api@1.1.9
  - create-langgraph@1.1.4

## 1.1.8

### Patch Changes

- Updated dependencies [[`a84c1ff`](https://github.com/langchain-ai/langgraphjs/commit/a84c1ff18289653ff4715bd0db4ac3d06600556e), [`a84c1ff`](https://github.com/langchain-ai/langgraphjs/commit/a84c1ff18289653ff4715bd0db4ac3d06600556e)]:
  - @langchain/langgraph-api@1.1.8
  - create-langgraph@1.1.3

## 1.1.7

### Patch Changes

- Updated dependencies [[`e9f7e8e`](https://github.com/langchain-ai/langgraphjs/commit/e9f7e8e9e6b8851cb7dd68e31d2f1867b62bd6bd), [`e9f7e8e`](https://github.com/langchain-ai/langgraphjs/commit/e9f7e8e9e6b8851cb7dd68e31d2f1867b62bd6bd)]:
  - @langchain/langgraph-api@1.1.7
  - create-langgraph@1.1.2

## 1.1.6

### Patch Changes

- Updated dependencies [3ec85a4]
- Updated dependencies [3ec85a4]
  - @langchain/langgraph-api@1.1.6
  - create-langgraph@1.1.1

## 1.1.5

### Patch Changes

- Updated dependencies [3613386]
  - @langchain/langgraph-api@1.1.5

## 1.1.4

### Patch Changes

- Updated dependencies [730dc7c]
  - @langchain/langgraph-api@1.1.4

## 1.1.3

### Patch Changes

- Updated dependencies [074da7f]
  - create-langgraph@1.1.0
  - @langchain/langgraph-api@1.1.3

## 1.1.2

### Patch Changes

- Updated dependencies [d08e484]
  - @langchain/langgraph-api@1.1.2

## 1.1.1

### Patch Changes

- Updated dependencies [35e8fc7]
  - @langchain/langgraph-api@1.1.1

## 1.1.0

### Minor Changes

- c71b92b: Updated the uv version to latest 0.9.11. Fixed error fixed EXDEV: cross-device link when using Python adapter

### Patch Changes

- @langchain/langgraph-api@1.1.0

## 1.0.4

### Patch Changes

- Updated dependencies [b9be526]
  - @langchain/langgraph-api@1.0.4

## 1.0.3

### Patch Changes

- 6cd8ecb: Remove Zod 3.x dependency constraint to allow Zod 4.x and avoid installing duplicate Zod packages
- Updated dependencies [6cd8ecb]
  - @langchain/langgraph-api@1.0.3

## 1.0.2

### Patch Changes

- Updated dependencies [ebe5ae7]
  - @langchain/langgraph-api@1.0.2

## 1.0.1

### Patch Changes

- Updated dependencies [610e1e1]
  - @langchain/langgraph-api@1.0.1

## 1.0.0

### Major Changes

- 1e1ecbb: This release updates the package for compatibility with LangGraph v1.0. See the [v1.0 release notes](https://docs.langchain.com/oss/javascript/releases/langgraph-v1) for details on what's new.

### Patch Changes

- Updated dependencies [1e1ecbb]
  - create-langgraph@1.0.0
  - @langchain/langgraph-api@1.0.0

## 0.0.71

### Patch Changes

- Updated dependencies [f5865ac]
  - @langchain/langgraph-api@0.0.71

## 0.0.70

### Patch Changes

- Updated dependencies [636e142]
  - @langchain/langgraph-api@0.0.70

## 0.0.69

### Patch Changes

- Updated dependencies [f2aa533]
  - @langchain/langgraph-api@0.0.69

## 0.0.68

### Patch Changes

- 7770c6a: Add `new` command to `@langchain/langgraph-cli` CLI
- Updated dependencies [7770c6a]
  - create-langgraph@0.0.4
  - @langchain/langgraph-api@0.0.68

## 0.0.67

### Patch Changes

- Updated dependencies [e23fa7f]
  - @langchain/langgraph-api@0.0.67

## 0.0.66

### Patch Changes

- Updated dependencies [5176f1c]
- Updated dependencies [68a1aa8]
  - @langchain/langgraph-api@0.0.66

## 0.0.65

### Patch Changes

- Updated dependencies [0aefafe]
  - @langchain/langgraph-api@0.0.65

## 0.0.64

### Patch Changes

- Updated dependencies [30bcfcd]
- Updated dependencies [572de43]
  - @langchain/langgraph-api@0.0.64

## 0.0.63

### Patch Changes

- Updated dependencies [c9d4dfd]
  - @langchain/langgraph-api@0.0.63

## 0.0.62

### Patch Changes

- Updated dependencies [c868796]
  - @langchain/langgraph-api@0.0.62

## 0.0.61

### Patch Changes

- Updated dependencies [a334897]
- Updated dependencies [9357bb7]
- Updated dependencies [9f13d74]
  - @langchain/langgraph-api@0.0.61

## 0.0.60

### Patch Changes

- Updated dependencies [9c57526]
  - @langchain/langgraph-api@0.0.60

## 0.0.59

### Patch Changes

- d28a9d7: fix(cli): sysinfo command failing to obtain dep versions for Node.js 20.x
- Updated dependencies [3412f9f]
  - @langchain/langgraph-api@0.0.59

## 0.0.58

### Patch Changes

- Updated dependencies [f65f619]
- Updated dependencies [c857357]
  - @langchain/langgraph-api@0.0.58

## 0.0.57

### Patch Changes

- 31cc9f7: support description property for `langgraph.json`
- 679a1be: Fix sysinfo command for PNPM
- 2f179e5: feat(cli): accept BROWSER=none to prevent spawning a browser
- Updated dependencies [31cc9f7]
  - @langchain/langgraph-api@0.0.57

## 0.0.56

### Patch Changes

- Updated dependencies [3c390c9]
  - @langchain/langgraph-api@0.0.56

## 0.0.55

### Patch Changes

- Updated dependencies [ef84039]
- Updated dependencies [7edf347]
- Updated dependencies [77b21d5]
  - @langchain/langgraph-api@0.0.55

## 0.0.54

### Patch Changes

- Updated dependencies [1777878]
  - @langchain/langgraph-api@0.0.54

## 0.0.53

### Patch Changes

- Updated dependencies [f1bcec7]
  - @langchain/langgraph-api@0.0.53

## 0.0.52

### Patch Changes

- Updated dependencies [030698f]
  - @langchain/langgraph-api@0.0.52

## 0.0.51

### Patch Changes

- 11319f7: fix(cli): allow node_version: 22 when pulling and building image
  - @langchain/langgraph-api@0.0.51

## 0.0.50

### Patch Changes

- 337b419: fix(cli): enable correct passthrough of docker build args
  - @langchain/langgraph-api@0.0.50

## 0.0.49

### Patch Changes

- 78a15a1: feat(cli): add sysinfo command to obtain actual version
- Updated dependencies [ee1defa]
  - @langchain/langgraph-api@0.0.49

## 0.0.48

### Patch Changes

- ac7b067: fix(sdk): use `kind` when checking for Studio user
- Updated dependencies [ac7b067]
  - @langchain/langgraph-api@0.0.48

## 0.0.47

### Patch Changes

- 39cc88f: Fix apply namespace to messages-tuple stream mode
- c1ddda1: Embed methods for obtaining state should use `getGraph(...)`
- Updated dependencies [39cc88f]
- Updated dependencies [c1ddda1]
  - @langchain/langgraph-api@0.0.47

## 0.0.46

### Patch Changes

- d172de3: Fix apply namespace to messages-tuple stream mode
- Updated dependencies [d172de3]
  - @langchain/langgraph-api@0.0.46

## 0.0.45

### Patch Changes

- 603daa6: Embed should properly handle `payload.checkpoint` and `payload.checkpoint_id`
- Updated dependencies [603daa6]
  - @langchain/langgraph-api@0.0.45

## 0.0.44

### Patch Changes

- 2f26f2f: Expose get/delete thread endpoint to embed server
- Updated dependencies [2f26f2f]
  - @langchain/langgraph-api@0.0.44

## 0.0.43

### Patch Changes

- ce0a39a: Fix invalid package.json dependencies
- Updated dependencies [ce0a39a]
  - @langchain/langgraph-api@0.0.43

## 0.0.42

### Patch Changes

- 972b66a: Support gen UI components namespaced with a hyphen
- Updated dependencies [972b66a]
  - @langchain/langgraph-api@0.0.42
