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

- **Required**: `--workspace <workspace name>`. eg: `--workspace @langchain/langgraph` (always appended as the first flag when running `yarn release`)
- **Optional**: `--bump-deps` eg `--bump-deps` Will find all packages in the repo which depend on this workspace and checkout a new branch, update the dep version, run yarn install, commit & push to new branch.
- **Optional**: `--tag <tag>` eg `--tag beta` Add a tag to the NPM release.

This script automatically bumps the package version, creates a new release branch with the changes, pushes the branch to GitHub, uses `release-it` to automatically release to NPM, and more depending on the flags passed.

Halfway through this script, you'll be prompted to enter an NPM OTP (typically from an authenticator app). This value is not stored anywhere and is only used to authenticate the NPM release.

Full example: `yarn release @langchain/langgraph --bump-deps --tag beta`.

### 🛠️ Tooling

This project uses the following tools, which are worth getting familiar
with if you plan to contribute:

- **[yarn](https://yarnpkg.com/) (v4.9.1)** - dependency management
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

Note that most integration tests require credentials or other setup. You will likely need to set up a `libs/langgraph/.env` file
like the example [here](https://github.com/langchain-ai/langgraphjs/blob/main/libs/langgraph/.env.example).

We generally recommend only running integration tests with `yarn test:single`, but if you want to run all integration tests, run:

```bash
yarn test:int
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

### Running docs locally

To run docs locally, switch to the `docs/` directory:

```bash
cd docs
```

Then, install the required dependencies with:

```bash
pip install -r docs-requirements.txt
```

Finally, run:

```bash
make serve-docs
```

And navigate to `http://127.0.0.1:8000/` to see your local build.

### Technical Concepts for Contributing to this Codebase

If you are contributing to this code base, then you need to be familiar with some of the underlying concepts that power the `Graph` class - LangGraph's main entrypoint. These concepts are intentionally not documented in the LangGraph docs because users of LangGraph do not need to understand them. This knowledge is exclusively for contributors.

#### Pregel

Let's start with Pregel. [Pregel](https://research.google/pubs/pregel-a-system-for-large-scale-graph-processing/) ([PDF](https://15799.courses.cs.cmu.edu/fall2013/static/papers/p135-malewicz.pdf)) is an API for building graphs.

Some key concepts:

- Pregel graphs take an `input` and `output` as parameters which represent where the graph starts and ends
- Pregel graphs take a mapping of nodes represented as `{nodeName: node}`
- Each node subscribes to (one or more) channels. This defines when a node executes. Specifically, for a given `node N` that subscribes to `channel M`, whenever the _value_ of `channel M` changes, `node N` must be executed. Intuitively, it represents what the current node is _dependent_ on.
- Each node writes to (one or more) channels. This defines where the final value after a node is executed is stored, because nodes don't store their own value.
- More on channels below.

To form an intuition around Pregel graphs, let's look at the example tests.

In the example below, the pregel graph is defined to start at `inputChannelName` and end at `outputChannelName`. The graph has a single node called `nodeOne` that transforms the input value by adding one to it. When the graph is invoked with an input value of `2`:

1. `inputChannelName` gets set to a value of `2`, because it is defined as the input channel.
2. Since `nodeOne` subscribes to `inputChannelName`, `nodeOne` executed.
3. `nodeOne` transforms `2` to `3` and `3` gets written to `outputChannelName`.
4. Since `outputChannelName` is defined as the graph's output, the execution ends and returns `3`.

```ts
const addOne = jest.fn((x: number): number => x + 1);
const chain = Channel.subscribeTo("inputChannelName")
  .pipe(addOne)
  .pipe(Channel.writeTo("outputChannelName"));

const app = new Pregel({
  nodes: { nodeOne: chain },
  input: ["inputChannelName"],
  output: ["outputChannelName"],
});

expect(await app.invoke({ input: 2 })).toEqual({ output: 3 });
```

This was a simple example, let's look at a more complicated example.

In the example below, the graph has one node. The `checkpointer` parameter in Pregel means that it persists the state at every step. If a checkpointer is specified, then `thread_id` must be specified every time the graph is invoked and it represents the unique id of that invocation.

Invocation 1:

1. When the graph is invoked with `2`, `input` channels value becomes `2`
2. Node `one` runs because it is subscribed to `input`. The node transforms `2` to `2` by running `inputPlusTotal`.
3. The value of channels `output` and `total` get set to `2` because node `one` writes to both channels
4. Because `memory` is passed into the graph, `total` at thread_id of `1` is saved as a value of `2`
5. The graph ends with `output`'s value which is `2`

Invocation 2:

1. `input` channel value set to `3`
2. Node `one` triggered. Node one transforms `3` to `totalValue + 3` = `2 + 3` = `5`
3. `total` is a `BinaryOperatorAggregate` channel. Hence, it transforms the inbox value `5` to `5 + prevTotalValue` = `5 + 2` = `7`
4. `output` channel's value is written as `5` and the graph returns with `5`

Invocation 3:

1. `input` channel value set to `5` with a `thread_id` of `2` indicating a new id for storage
2. Node `one` triggered. Node one transforms `5` to `totalValue_in_thread_id_2 + 3` = `0 + 5` = `5`
3. Checking the value of `total` in `thread_id_1` is still the same as the value in invocation 2 which is `7`.
4. `output` channel's value is written as `5` and the graph returns with `5`

```ts
it("should handle checkpoints correctly", async () => {
  const inputPlusTotal = jest.fn(
    (x: { total: number; input: number }): number => x.total + x.input,
  );

  const one = Channel.subscribeTo(["input"])
    .join(["total"])
    .pipe(inputPlusTotal)
    .pipe(Channel.writeTo("output", "total"));

  const memory = new MemorySaver();

  const app = new Pregel({
    nodes: { one },
    channels: { total: new BinaryOperatorAggregate<number>((a, b) => a + b) },
    checkpointer: memory,
  });

  // Invocation 1
  await expect(
    app.invoke(2, { configurable: { thread_id: "1" } }),
  ).resolves.toBe(2);
  let checkpoint = memory.get({ configurable: { thread_id: "1" } });
  expect(checkpoint).not.toBeNull();
  expect(checkpoint?.channelValues.total).toBe(2);

  // Invocation 2
  await expect(
    app.invoke(3, { configurable: { thread_id: "1" } }),
  ).resolves.toBe(5);
  checkpoint = memory.get({ configurable: { thread_id: "1" } });
  expect(checkpoint?.channelValues.total).toBe(7);

  // Invocation 3
  await expect(
    app.invoke(5, { configurable: { thread_id: "2" } }),
  ).resolves.toBe(5);
  checkpoint = memory.get({ configurable: { thread_id: "2" } });
  expect(checkpoint?.channelValues.total).toBe(5);
  checkpoint = memory.get({ configurable: { thread_id: "1" } });
  expect(checkpoint?.channelValues.total).toBe(7);
});
```

Those are some of the fundamentals of how a Pregel graph works. To get a deeper understanding of how Pregel works, you can check out its expected behavior in `pregel.test.ts`.

#### Channels

Some concepts about channels:

1. Channels are the way nodes communicate with one another in Pregel. If it were not for channels, nodes would have no way of storing values or denoting dependencies on other nodes.
2. At its core, every channel does a couple things:

- It stores a current value.
- It implements a way to `update` its current value based on the expected parameter for the update function.
- It implements a way to `checkpoint` or "snapshot" the current state of the channel. This enables persistence across a graph.
- It implements a way to `empty` or "restore" a channel from a checkpoint/snapshot. This enables us to create a new channel from a checkpoint variable stored in a database.

3. `channels/base.ts` is the base class for a channel and it can be extended to create any kind of channel. For example, `last_value.ts`, `binop.ts` are all types of channels.
4. In Pregel, there is no limitation on the number of channels a node can subscribe to or write to. In LangGraph, however, currently every node maps to two channels. (1) A channel's value that it is subscribes to, i.e - is dependent on. (2) The channel that it writes to.
5. `src/pregel/index.ts` holds all the business logic that uses channels and nodes in a pregel graph. `async *_transform` holds some of the most important logic because it is responsible for updating the channel's value and updating the checkpoint accordingly.
