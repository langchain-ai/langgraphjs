# @langchain/langgraph-checkpoint-mysql

Implementation of a [LangGraph.js](https://github.com/langchain-ai/langgraphjs) CheckpointSaver that uses a MySQL DB.

- Database operations are implemented through [Sequelize v6](https://sequelize.org/).
- Support `MySQL >= 5.7`
- Implementation follow the style(including code style / table structure) of [@langchain/langgraph-checkpoint-postgres](https://www.npmjs.com/package/@langchain/langgraph-checkpoint-postgres)
- Inspired by [https://github.com/tjni/langgraph-checkpoint-mysql](https://github.com/tjni/langgraph-checkpoint-mysql)

## Usage

```ts
import { MySQLSaver } from "@langchain/langgraph-checkpoint-mysql";

const writeConfig = {
  configurable: {
    thread_id: "1",
    checkpoint_ns: "",
  },
};
const readConfig = {
  configurable: {
    thread_id: "1",
  },
};

// you can optionally pass a configuration object as the second parameter
const checkpointer = MySQLSaver.fromConnString("mysql://...");

// or you can initialize the sequelize instance first
// const sequelize = new Sequelize({
//   database: 'testdb',
//   username: 'root',
//   password: '123456',
//   host: '127.0.0.1',
//   port: 3306,
//   dialect: 'mysql',
// });

// const checkpointer = new MySQLSaver(sequelize);

// You should call .setup() the first time you use the checkpointer:
await checkpointer.setup();

// or you can set the table manually by using the sql in `/src/migration.sql`

const checkpoint = {
  v: 1,
  ts: "2024-07-31T20:14:19.804150+00:00",
  id: "1ef4f797-8335-6428-8001-8a1503f9b875",
  channel_values: {
    my_key: "meow",
    node: "node",
  },
  channel_versions: {
    __start__: 2,
    my_key: 3,
    "start:node": 3,
    node: 3,
  },
  versions_seen: {
    __input__: {},
    __start__: {
      __start__: 1,
    },
    node: {
      "start:node": 2,
    },
  },
  pending_sends: [],
};

// store checkpoint
await checkpointer.put(writeConfig, checkpoint, {}, {});

// load checkpoint
await checkpointer.get(readConfig);

// list checkpoints
for await (const checkpoint of checkpointer.list(readConfig)) {
  console.log(checkpoint);
}
```

## Testing

Spin up testing MySQL

```bash
docker-compose up -d && docker-compose logs -f
```

Then rename the test file `./src/tests/checkpoints.int.test.ts` to `./src/tests/checkpoints.test.ts`

Run the test script

```bash
yarn test

# or yarn test:watch
```
