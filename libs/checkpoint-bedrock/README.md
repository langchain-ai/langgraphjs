# @langchain/langgraph-checkpoint-bedrock

Implementation of a [LangGraph.js](https://github.com/langchain-ai/langgraphjs) CheckpointSaver that uses Amazon Bedrock Agent Runtime sessions for persistence.

## Installation

```bash
npm install @langchain/langgraph-checkpoint-bedrock @aws-sdk/client-bedrock-agent-runtime
```

## Usage

```ts
import { BedrockSessionSaver } from "@langchain/langgraph-checkpoint-bedrock";

// Initialize the saver with AWS configuration
const checkpointer = new BedrockSessionSaver(
  "us-east-1", // AWS region
  "default" // Optional: AWS credentials profile name
  // Alternatively, you can provide direct credentials:
  // awsAccessKeyId,
  // awsSecretAccessKey,
  // awsSessionToken,
  // endpointUrl
);

// Create a new session (default encryption with AWS-managed keys)
const sessionId = await checkpointer.createSession();

// Create a session with customer-managed KMS key for encryption
const encryptedSessionId = await checkpointer.createSession({
  tags: { Purpose: "Demo" },
  encryptionKeyArn:
    "arn:aws:kms:us-east-1:123456789012:key/abcd1234-ab12-cd34-ef56-abcdef123456",
});

// Configuration for writing and reading checkpoints
const writeConfig = {
  configurable: {
    thread_id: sessionId,
    checkpoint_ns: "my-namespace",
  },
};

const readConfig = {
  configurable: {
    thread_id: sessionId,
  },
};

// Example checkpoint data
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

// Store checkpoint
await checkpointer.put(writeConfig, checkpoint, {}, {});

// Load checkpoint
const retrievedCheckpoint = await checkpointer.getTuple(readConfig);

// List checkpoints
for await (const checkpoint of checkpointer.list(readConfig)) {
  console.log(checkpoint);
}
```

## Features

- Persists LangGraph checkpoints using Amazon Bedrock Agent Runtime sessions
- Supports storing and retrieving checkpoint data and pending writes
- Provides checkpoint listing with filtering capabilities
- Handles checkpoint metadata and versioning
- Automatically manages AWS credentials and region configuration
- Supports customer-managed KMS keys for enhanced security

## Session Encryption

By default, Amazon Bedrock uses AWS-managed keys for session encryption. For additional security, you can encrypt session data with a customer-managed key by providing the key's ARN when creating a session:

```ts
const sessionId = await checkpointer.createSession({
  encryptionKeyArn:
    "arn:aws:kms:us-east-1:123456789012:key/abcd1234-ab12-cd34-ef56-abcdef123456",
});
```

The user or role creating the session must have the following permissions to use the key:

- `kms:Encrypt`
- `kms:Decrypt`
- `kms:GenerateDataKey`
- `kms:DescribeKey`

For more information, see [Session encryption](https://docs.aws.amazon.com/bedrock/latest/userguide/sessions-encryption.html) in the Amazon Bedrock documentation.

## AWS Credentials

The BedrockSessionSaver supports multiple ways to provide AWS credentials:

1. **AWS Region and Profile**: Provide region name and credentials profile name
2. **Direct Credentials**: Provide access key ID, secret access key, and optional session token
3. **Environment Variables**: Uses AWS SDK's default credential provider chain
4. **Custom Endpoint**: Optionally specify a custom endpoint URL for testing or VPC endpoints

## Requirements

- Node.js 18 or later
- AWS account with access to Amazon Bedrock Agent Runtime
- Appropriate IAM permissions for Bedrock Agent Runtime operations
