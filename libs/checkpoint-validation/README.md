# @langchain/langgraph-checkpoint-validation

The checkpointer validation tool is used to validate that custom checkpointer implementations conform to LangGraph's requirements. LangGraph uses [checkpointers](https://langchain-ai.github.io/langgraphjs/concepts/persistence/#checkpointer-libraries) for persisting workflow state, providing the ability to "rewind" your workflow to some earlier point in time, and continue execution from there.

The overall process for using this tool is as follows:

1. Write your custom checkpointer implementation.
2. Add a file to your project that defines a [`CheckpointerTestInitializer`](./src/types.ts) as its default export.
3. Run the checkpointer validation tool to test your checkpointer and determine whether it meets LangGraph's requirements.
4. Iterate on your custom checkpointer as required, until tests pass.

The tool can be executed from the terminal as a CLI, or you can use it as a library to integrate it into your test suite.

## Writing a CheckpointerTestInitializer

The `CheckpointerTestInitializer` interface ([example](./src/tests/postgres_initializer.ts)) is used by the test harness to create instances of your custom checkpointer, and any infrastructure that it requires for testing purposes.

If you intend to execute the tool via the CLI, your `CheckpointerTestInitializer` **must** be the default export of the module in which it is defined.

**Synchronous vs Asynchronous initializer functions**: You may return promises from any functions defined in your `CheckpointerTestInitializer` according to your needs and the test harness will behave accordingly.

**IMPORTANT**: You must take care to write your `CheckpointerTestInitializer` such that instances of your custom checkpointer are isolated from one another with respect to persisted state, or else some tests (particularly the ones that exercise the `list` method) will fail. That is, state written by one instance of your checkpointer MUST NOT be readable by another instance of your checkpointer. That said, there will only ever be one instance of your checkpointer live at any given time, so **you may use shared storage, provided it is cleared when your checkpointer is created or destroyed.** The structure of the `CheckpointerTestInitializer` interface should make this relatively easy to achieve, per the sections below.


### (Required) `checkpointerName`: Define a name for your checkpointer

`CheckpointerTestInitializer` requires you to define a `checkpointerName` field (of type `string`) for use in the test output.

### `beforeAll`: Set up required infrastructure

If your checkpointer requires some external infrastructure to be provisioned, you may wish to provision this via the **optional** `beforeAll` function. This function executes exactly once, at the very start of the testing lifecycle. If defined, it is the first function that will be called from your `CheckpointerTestInitializer`.

**Timeout duration**: If your `beforeAll` function may take longer than 10 seconds to execute, you can assign a custom timeout duration (as milliseconds) to the optional `beforeAllTimeout` field of your `CheckpointerTestInitializer`.

**State isolation note**: Depending on the cost/performance/requirements of your checkpointer infrastructure, it **may** make more sense for you to provision it during the `createCheckpointer` step, so you can provide each checkpointer instance with its own isolated storage backend. However as mentioned above, you may also provision a single shared storage backend, provided you clear any stored data during the `createCheckpointer` or `destroyCheckpointer` step.

### `afterAll`: Tear down required infrastructure

If you set up infrastructure during the `beforeAll` step, you may need to tear it down once the tests complete their execution. You can define this teardown logic in the optional `afterAll` function. Much like `beforeAll` this function will execute exactly one time, after all tests have finished executing.

**IMPORTANT**: If you kill the test runner early this function may not be called. To avoid manual clean-up, give preference to test infrastructure management tools like [TestContainers](https://testcontainers.com/guides/getting-started-with-testcontainers-for-nodejs/), as these tools are designed to detect when this happens and clean up after themselves once the controlling process dies.

### (Required) `createCheckpointer`: Construct your checkpointer

`CheckpointerTestInitializer` requires you to define a `createCheckpointer()` function that returns an instance of your custom checkpointer.

**State isolation note:** If you're provisioning storage during this step, make sure that it is "fresh" storage for each instance of your checkpointer. Otherwise if you are using a shared storage setup, be sure to clear it either in this function, or in the `destroyCheckpointer` function (described in the section below).

### `destroyCheckpointer`: Destroy your checkpointer

If your custom checkpointer requires an explicit teardown step (for example, to clean up database connections), you can define this in the **optional** `destroyCheckpointer(checkpointer: CheckpointerT)` function.

**State isolation note:** If you are using a shared storage setup, be sure to clear it either in this function, or in the `createCheckpointer` function (described in the section above).

## CLI usage

You may use this tool's CLI either via `npx`, `yarn dlx`, or by installing globally and executing it via the `validate-checkpointer` command.

The only required argument to the tool is the import path for your `CheckpointerTestInitializer`. Relative paths must begin with a leading `./` (or `.\`, for Windows), otherwise the path will be interpreted as a module name rather than a relative path.

You may optionally pass one or more test filters as positional arguments after the import path argument (separated by spaces). Valid values are `getTuple`, `list`, `put`, and `putWrites`. If present, only the test suites specified in the filter list will be executed. This is useful for working through smaller sets of test failures as you're validating your checkpointer.

TypeScript imports **are** supported, so you may pass a path directly to your TypeScript source file.

### NPX & Yarn execution

NPX:

```bash
npx @langchain/langgraph-checkpoint-validation ./src/my_initializer.ts
```

Yarn:

```bash
yarn dlx @langchain/langgraph-checkpoint-validation ./src/my_initializer.ts
```

### Global install

NPM:

```bash
npm install -g @langchain/langgraph-checkpoint-validation
validate-checkpointer ./src/my_initializer.ts
```

## Usage in existing Jest test suite

If you wish to integrate this tooling into your existing Jest test suite, you import it as a library, as shown below.

```ts
import { validate } from "@langchain/langgraph-validation";

validate(MyCheckpointerInitializer);
```
