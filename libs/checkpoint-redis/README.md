# @langchain/langgraph-checkpoint-redis

Implementation of a [LangGraph.js](https://github.com/langchain-ai/langgraphjs) CheckpointSaver that uses Redis.

## Usage

```ts
import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";
import { Redis } from "ioredis";

const redis = new Redis();

const checkpointer = new RedisSaver({ connection: redis });
```

## Testing

Testing the RedisSaver with real Redis

```bash
docker-compose up -d && docker-compose logs -f
```

Then Run the tests.
