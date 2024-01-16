# Contributing to LangGraph

👋 Hi there! Thank you for being interested in contributing to LangGraph.
As an open source project in a rapidly developing field, we are extremely open
to contributions, whether it be in the form of a new feature, improved infra, or better documentation.

To contribute to this project, please follow a ["fork and pull request"](https://docs.github.com/en/get-started/quickstart/contributing-to-projects) workflow. Please do not try to push directly to this repo unless you are a maintainer.

## Quick Links

### Not sure what to work on?

If you are not sure what to work on, we have a few suggestions:

- Look at the issues with the [help wanted](https://github.com/langchain-ai/langgraphjs/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) label. These are issues that we think are good targets for contributors. If you are interested in working on one of these, please comment on the issue so that we can assign it to you. And if you have any questions let us know, we're happy to guide you!

### New abstractions

We aim to keep the same core APIs between the Python and JS versions of LangGraph, where possible. As such we ask that if you have an idea for a new abstraction, please open an issue first to discuss it. This will help us make sure that the API is consistent across both versions. If you're not sure what to work on, we recommend looking at the links above first.

## 🗺️ Contributing Guidelines

### 🚩 GitHub Issues

Our [issues](https://github.com/langchain-ai/langgraphjs/issues) page contains
with bugs, improvements, and feature requests.

If you start working on an issue, please comment and a maintainer can assign it to you.

If you are adding an issue, please try to keep it focused on a single modular bug/improvement/feature.
If the two issues are related, or blocking, please link them rather than keep them as one single one.

We will try to keep these issues as up to date as possible, though
with the rapid rate of development in this field some may get out of date.
If you notice this happening, please just let us know.

### 🙋 Getting Help

Although we try to have a developer setup to make it as easy as possible for others to contribute (see below)
it is possible that some pain point may arise around environment setup, linting, documentation, or other.
Should that occur, please contact a maintainer! Not only do we want to help get you unblocked,
but we also want to make sure that the process is smooth for future contributors.

In a similar vein, we do enforce certain linting, formatting, and documentation standards in the codebase.
If you are finding these difficult (or even just annoying) to work with,
feel free to contact a maintainer for help - we do not want these to get in the way of getting
good code into the codebase.

### 🏭 Release process

As of now, LangGraph has an ad hoc release process: releases are cut with high frequency via by
a developer and published to [npm](https://www.npmjs.com/package/@angchain/langgraph).

LangChain follows the [semver](https://semver.org/) versioning standard. However, as pre-1.0 software,
even patch releases may contain [non-backwards-compatible changes](https://semver.org/#spec-item-4).

If your contribution has made its way into a release, we will want to give you credit on Twitter (only if you want though)!
If you have a Twitter account you would like us to mention, please let us know in the PR or in another manner.

#### Integration releases

You can invoke the release flow by calling `yarn release` from the package root.

There are three parameters which can be passed to this script, one required and two optional.

- __Required__: `--workspace <workspace name>`. eg: `--workspace @langchain/langgraph` (always appended as the first flag when running `yarn release`)
- __Optional__: `--bump-deps` eg `--bump-deps` Will find all packages in the repo which depend on this workspace and checkout a new branch, update the dep version, run yarn install, commit & push to new branch.
- __Optional__: `--tag <tag>` eg `--tag beta` Add a tag to the NPM release.

This script automatically bumps the package version, creates a new release branch with the changes, pushes the branch to GitHub, uses `release-it` to automatically release to NPM, and more depending on the flags passed.

Halfway through this script, you'll be prompted to enter an NPM OTP (typically from an authenticator app). This value is not stored anywhere and is only used to authenticate the NPM release.

Full example: `yarn release @langchain/langgraph --bump-deps --tag beta`. 

### 🛠️ Tooling

This project uses the following tools, which are worth getting familiar
with if you plan to contribute:

- **[yarn](https://yarnpkg.com/) (v3.4.1)** - dependency management
- **[eslint](https://eslint.org/)** - enforcing standard lint rules
- **[prettier](https://prettier.io/)** - enforcing standard code formatting
- **[jest](https://jestjs.io/)** - testing code

## 🚀 Quick Start

Clone this repo, then cd into it:

```bash
cd langgraph
```

Next, try running the following common tasks:

## ✅ Common Tasks

Our goal is to make it as easy as possible for you to contribute to this project.
All of the below commands should be run from within a workspace directory (e.g. `langgraph`) unless otherwise noted.

```bash
cd langgraph
```

### Setup

To get started, you will need to install the dependencies for the project. To do so, run:

```bash
yarn
```

Then you can build the project with:

```bash
yarn build
```

### Linting

We use [eslint](https://eslint.org/) to enforce standard lint rules.
To run the linter, run:

```bash
yarn lint
```

or to automatically fix linting errors, run:

```bash
yarn lint:fix
```

### Formatting

We use [prettier](https://prettier.io) to enforce code formatting style.
To run the formatter, run:

```bash
yarn format
```

To just check for formatting differences, without fixing them, run:

```bash
yarn format:check
```

### Testing

In general, tests should be added within a `tests/` folder alongside the modules they
are testing.

**Unit tests** cover modular logic that does not require calls to outside APIs.

If you add new logic, please add a unit test.
Unit tests should be called `*.test.ts`.

To run only unit tests, run:

```bash
yarn test
```

#### Running a single test

To run a single test, run the following from within a workspace:

```bash
yarn test:single /path/to/yourtest.test.ts
```

This is useful for developing individual features.

**Integration tests** cover logic that requires making calls to outside APIs (often integration with other services).

If you add support for a new external API, please add a new integration test.
Integration tests should be called `*.int.test.ts`.

Note that most integration tests require credentials or other setup. You will likely need to set up a `langgraph/.env` file
like the example [here](https://github.com/langchain-ai/langgraphjs/blob/main/langgraph/.env.example).

We generally recommend only running integration tests with `yarn test:single`, but if you want to run all integration tests, run:

```bash
yarn test:integration
```

### Building

To build the project, run:

```bash
yarn build
```

### Adding an Entrypoint

LangGraph exposes multiple subpaths the user can import from, e.g.

```typescript
import { Pregel } from "@langchain/langgraph/pregel";
```

We call these subpaths "entrypoints". In general, you should create a new entrypoint if you are adding a new integration with a 3rd party library. If you're adding self-contained functionality without any external dependencies, you can add it to an existing entrypoint.

In order to declare a new entrypoint that users can import from, you
should edit the `langgraph/scripts/create-entrypoints.js` script. To add an
entrypoint `tools` that imports from `tools/index.ts` you'd add
the following to the `entrypoints` variable:

```typescript
const entrypoints = {
  // ...
  tools: "tools/index",
};
```

This will make sure the entrypoint is included in the published package,
and in generated documentation.
