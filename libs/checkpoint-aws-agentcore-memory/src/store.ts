import {
  BaseStore,
  type OperationResults,
  type Item,
  type Operation,
  type PutOperation,
  type GetOperation,
  type SearchOperation,
  type ListNamespacesOperation,
  type SearchItem,
} from "@langchain/langgraph-checkpoint";
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListEventsCommand,
  RetrieveMemoryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { ConfiguredRetryStrategy } from "@smithy/util-retry";

// Type definitions for AWS SDK compatibility
interface AWSError extends Error {
  name: string;
  code?: string;
  statusCode?: number;
}

export interface AgentCoreMemoryStoreParams {
  memoryId: string;
  region?: string;
}

/**
 * AWS Bedrock AgentCore Memory implementation of BaseStore.
 *
 * This store uses AgentCore Memory for persistent key-value storage with
 * optional vector similarity search capabilities.
 */
export class AgentCoreMemoryStore extends BaseStore {
  private client: BedrockAgentCoreClient;

  private memoryId: string;

  private lastRequestTime = 0;

  private readonly MIN_REQUEST_INTERVAL = 60; // 60ms between requests (16.7 req/sec, under 20/sec limit)

  private defaultActorId?: string; // Unique default actor ID per instance

  constructor({ memoryId, region }: AgentCoreMemoryStoreParams) {
    super();
    this.memoryId = memoryId;
    this.client = new BedrockAgentCoreClient({
      region,
      retryStrategy: new ConfiguredRetryStrategy(
        3, // maxAttempts
        (attempt: number) => Math.min(1000 * 2 ** attempt, 10000) // exponential backoff with max 10s
      ),
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 30000,
        socketTimeout: 30000,
      }),
    });
  }

  private decodeBlob(blob: string | Uint8Array | unknown): string {
    if (typeof blob === "string") {
      // Skip empty or very short strings
      if (blob.length < 4) {
        return blob;
      }

      // Check if it looks like Base64 and has proper length
      if (/^[A-Za-z0-9+/]*={0,2}$/.test(blob) && blob.length % 4 === 0) {
        try {
          const decoded = atob(blob);
          // Convert binary string back to Uint8Array
          const bytes = new Uint8Array(decoded.length);
          for (let i = 0; i < decoded.length; i++) {
            bytes[i] = decoded.charCodeAt(i);
          }
          // Use TextDecoder for proper Unicode handling
          const decoder = new TextDecoder();
          const unicodeDecoded = decoder.decode(bytes);
          // Additional validation - decoded should be reasonable length
          if (unicodeDecoded.length > 0 && unicodeDecoded.length < 1000000) {
            return unicodeDecoded;
          }
        } catch {
          // Base64 decode failed, fall through to return original
        }
      }
      return blob;
    }
    if (blob instanceof Uint8Array) {
      return new TextDecoder().decode(blob);
    }
    // Handle other potential blob formats
    return JSON.stringify(blob);
  }

  /** @internal */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.MIN_REQUEST_INTERVAL - timeSinceLastRequest)
      );
    }
    this.lastRequestTime = Date.now();
  }

  private getActorId(namespace: string[]): string {
    // Use second part of namespace as actor ID, or default
    const actorId = namespace.length > 1 ? namespace[1] : undefined;
    if (!actorId) {
      // For validation tests, provide a unique default actor_id per instance
      if (!this.defaultActorId) {
        this.defaultActorId = `store-actor-${Date.now()}-${Math.random()
          .toString(36)
          .substring(2, 11)}`;
      }
      return this.defaultActorId;
    }
    return actorId;
  }

  private getSessionId(namespace: string[]): string {
    // Use the first part of namespace as session ID, or default
    return namespace.length > 0 ? namespace[0] : "default";
  }

  async batch<Op extends readonly Operation[]>(
    operations: Op
  ): Promise<OperationResults<Op>> {
    const results = [];

    for (const op of operations) {
      if ("value" in op) {
        // PutOperation
        await this.handlePut(op as PutOperation);
        results.push(undefined);
      } else if ("namespacePrefix" in op) {
        // SearchOperation
        const searchResults = await this.handleSearch(op as SearchOperation);
        results.push(searchResults);
      } else if ("key" in op && "namespace" in op) {
        // GetOperation
        const item = await this.handleGet(op as GetOperation);
        results.push(item);
      } else if ("matchConditions" in op || "maxDepth" in op) {
        // ListNamespacesOperation
        const namespaces = await this.handleListNamespaces(
          op as ListNamespacesOperation
        );
        results.push(namespaces);
      } else {
        throw new Error(`Unsupported operation: ${JSON.stringify(op)}`);
      }
    }

    return results as OperationResults<Op>;
  }

  private async handlePut(op: PutOperation): Promise<void> {
    if (op.value === null) {
      // Deletion - AgentCore Memory doesn't support direct deletion
      // We could mark items as deleted or skip this operation
      console.warn("Delete operations are not supported by AgentCore Memory");
      return;
    }

    const sessionId = this.getSessionId(op.namespace);
    const actorId = this.getActorId(op.namespace);

    // Store the item as an event
    const itemData = {
      type: "store_item",
      namespace: op.namespace,
      key: op.key,
      value: op.value,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      const dataString = JSON.stringify(itemData);
      // Use TextEncoder for proper Unicode handling
      const encoder = new TextEncoder();
      const bytes = encoder.encode(dataString);
      // Convert bytes to binary string for btoa
      const binaryString = Array.from(bytes, (byte) =>
        String.fromCharCode(byte)
      ).join("");
      const blobData = btoa(binaryString);

      await this.rateLimit();
      await this.client.send(
        new CreateEventCommand({
          memoryId: this.memoryId,
          actorId,
          sessionId,
          eventTimestamp: new Date(),
          payload: [
            {
              blob: blobData,
            },
          ],
          metadata: {
            type: { stringValue: "store_item" },
            namespace: { stringValue: op.namespace.join(":") },
            key: { stringValue: op.key },
          },
        })
      );
    } catch (error) {
      console.error("Error storing item:", error);
      throw error;
    }
  }

  private async handleGet(op: GetOperation): Promise<Item | null> {
    const sessionId = this.getSessionId(op.namespace);
    const actorId = this.getActorId(op.namespace);

    try {
      await this.rateLimit();
      const response = await this.client.send(
        new ListEventsCommand({
          memoryId: this.memoryId,
          actorId,
          sessionId,
          includePayloads: true,
          maxResults: 100,
          filter: {
            eventMetadata: [
              {
                left: { metadataKey: "type" },
                operator: "EQUALS_TO",
                right: { metadataValue: { stringValue: "store_item" } },
              },
              {
                left: { metadataKey: "key" },
                operator: "EQUALS_TO",
                right: { metadataValue: { stringValue: op.key } },
              },
            ],
          },
        })
      );

      const events = response.events || [];

      // Find the most recent event for this key
      let latestItem: Item | null = null;
      let latestTimestamp = 0;

      for (const event of events) {
        const payload = event.payload?.[0];
        if (!payload?.blob) continue;

        try {
          const blobStr = this.decodeBlob(payload.blob);
          // Add validation before parsing
          if (!blobStr || blobStr.length < 2) {
            continue;
          }
          // Skip if it doesn't look like JSON
          if (
            !blobStr.trim().startsWith("{") &&
            !blobStr.trim().startsWith("[")
          ) {
            continue;
          }
          const data = JSON.parse(blobStr);
          if (data.type === "store_item" && data.key === op.key) {
            const timestamp = new Date(event.eventTimestamp || 0).getTime();
            if (timestamp > latestTimestamp) {
              latestTimestamp = timestamp;
              latestItem = {
                namespace: data.namespace,
                key: data.key,
                value: data.value,
                createdAt: new Date(data.createdAt),
                updatedAt: new Date(data.updatedAt),
              };
            }
          }
        } catch (error) {
          console.error(
            "Error parsing event data:",
            error,
            "Raw blob:",
            payload.blob,
            "Decoded:",
            this.decodeBlob(payload.blob)
          );
          continue;
        }
      }

      return latestItem;
    } catch (error) {
      if ((error as AWSError).name === "ResourceNotFoundException") {
        return null;
      }
      throw error;
    }
  }

  private async handleSearch(op: SearchOperation): Promise<SearchItem[]> {
    if (op.query) {
      // Use vector search
      return this.performVectorSearch(op);
    } else {
      // Use metadata filtering
      return this.performMetadataSearch(op);
    }
  }

  private async performVectorSearch(
    op: SearchOperation
  ): Promise<SearchItem[]> {
    const namespaceStr = this.namespaceToString(op.namespacePrefix);

    try {
      const response = await this.client.send(
        new RetrieveMemoryRecordsCommand({
          memoryId: this.memoryId,
          namespace: namespaceStr,
          searchCriteria: {
            searchQuery: op.query!,
            topK: op.limit || 10,
          },
          maxResults: op.limit || 10,
        })
      );

      const records = response.memoryRecordSummaries || [];
      return records.map((record): SearchItem => {
        const content = record.content || {};
        const text =
          typeof content === "object" && content !== null
            ? (content as Record<string, unknown>).text || ""
            : String(content);

        return {
          namespace: op.namespacePrefix,
          key: record.memoryRecordId || crypto.randomUUID(),
          value: {
            content: text,
            memoryStrategyId: record.memoryStrategyId,
            namespaces: record.namespaces || [],
          },
          createdAt: new Date(record.createdAt || Date.now()),
          updatedAt: new Date(record.createdAt || Date.now()),
          score: record.score ? Number(record.score) : undefined,
        };
      });
    } catch (error) {
      if ((error as AWSError).name === "ResourceNotFoundException") {
        return [];
      }
      throw error;
    }
  }

  private async performMetadataSearch(
    op: SearchOperation
  ): Promise<SearchItem[]> {
    const sessionId = this.getSessionId(op.namespacePrefix);
    const actorId = this.getActorId(op.namespacePrefix);

    try {
      await this.rateLimit();
      const response = await this.client.send(
        new ListEventsCommand({
          memoryId: this.memoryId,
          actorId,
          sessionId,
          includePayloads: true,
          maxResults: op.limit || 100,
          filter: {
            eventMetadata: [
              {
                left: { metadataKey: "type" },
                operator: "EQUALS_TO",
                right: { metadataValue: { stringValue: "store_item" } },
              },
            ],
          },
        })
      );

      const events = response.events || [];
      const items: SearchItem[] = [];
      const seenKeys = new Set<string>();

      for (const event of events) {
        const payload = event.payload?.[0];
        if (!payload?.blob) continue;

        try {
          const blobStr = this.decodeBlob(payload.blob);
          // Add validation before parsing
          if (!blobStr || blobStr.length < 2) {
            continue;
          }
          // Skip if it doesn't look like JSON
          if (
            !blobStr.trim().startsWith("{") &&
            !blobStr.trim().startsWith("[")
          ) {
            continue;
          }
          const data = JSON.parse(blobStr);
          if (data.type === "store_item") {
            const itemKey = `${data.namespace.join(":")}:${data.key}`;

            // Skip if we've already seen this key (keep most recent)
            if (seenKeys.has(itemKey)) continue;
            seenKeys.add(itemKey);

            // Apply filter if provided
            if (op.filter) {
              const matches = Object.entries(op.filter).every(([key, value]) =>
                this.compareValues(data.value[key], value)
              );
              if (!matches) continue;
            }

            items.push({
              namespace: data.namespace,
              key: data.key,
              value: data.value,
              createdAt: new Date(data.createdAt),
              updatedAt: new Date(data.updatedAt),
            });
          }
        } catch (error) {
          console.error(
            "Error parsing event data:",
            error,
            "Raw blob:",
            payload.blob,
            "Decoded:",
            this.decodeBlob(payload.blob)
          );
          continue;
        }
      }

      // Apply offset and limit
      const offset = op.offset || 0;
      const limit = op.limit || items.length;
      return items.slice(offset, offset + limit);
    } catch (error) {
      if ((error as AWSError).name === "ResourceNotFoundException") {
        return [];
      }
      throw error;
    }
  }

  private async handleListNamespaces(
    _op: ListNamespacesOperation
  ): Promise<string[][]> {
    // AgentCore Memory doesn't have a direct way to list namespaces
    // We would need to scan all events and extract unique namespace patterns
    // For now, return empty array
    console.warn("listNamespaces is not fully supported by AgentCore Memory");
    return [];
  }

  private namespaceToString(namespace: string[]): string {
    return namespace.length > 0 ? `/${namespace.join("/")}` : "/";
  }

  private compareValues(actual: unknown, expected: unknown): boolean {
    if (typeof expected === "object" && expected !== null) {
      // Handle comparison operators
      const operators = expected as Record<string, unknown>;

      for (const [op, value] of Object.entries(operators)) {
        switch (op) {
          case "$eq":
            return actual === value;
          case "$ne":
            return actual !== value;
          case "$gt":
            return (
              typeof actual === "number" &&
              typeof value === "number" &&
              actual > value
            );
          case "$gte":
            return (
              typeof actual === "number" &&
              typeof value === "number" &&
              actual >= value
            );
          case "$lt":
            return (
              typeof actual === "number" &&
              typeof value === "number" &&
              actual < value
            );
          case "$lte":
            return (
              typeof actual === "number" &&
              typeof value === "number" &&
              actual <= value
            );
          default:
            return false;
        }
      }
      return false;
    }

    // Direct comparison
    return actual === expected;
  }
}
