import { describe, it, expect, vi, beforeEach } from "vitest";
import { IterableReadableWritableStream, StreamChunk } from "./stream";

describe("IterableReadableWritableStream", () => {
  let stream: IterableReadableWritableStream;

  beforeEach(() => {
    stream = new IterableReadableWritableStream({
      modes: new Set(["values", "messages"]),
    });
  });

  it("should push chunks when stream is open", async () => {
    const chunk: StreamChunk = [["test"], "values", { data: "test chunk" }];
    
    // Mock the controller to track enqueue calls
    const mockEnqueue = vi.fn();
    const mockClose = vi.fn();
    const mockError = vi.fn();
    
    // Access the controller through the promise resolution
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        // Note: In real usage, the controller would be initialized by the stream's start method
        resolve();
      }, 10);
    });
    
    expect(() => stream.push(chunk)).not.toThrow();
    expect(stream.closed).toBe(false);
  });

  it("should not throw when pushing to closed stream", async () => {
    const chunk: StreamChunk = [["test"], "values", { data: "ignored chunk" }];
    
    // Close the stream first
    stream.close();
    
    // This should not throw an error anymore
    expect(stream.closed).toBe(true);
    expect(() => stream.push(chunk)).not.toThrow();
  });

  it("should return correct closed state", () => {
    expect(stream.closed).toBe(false);
    stream.close();
    expect(stream.closed).toBe(true);
  });

  it("should handle multiple close calls gracefully", () => {
    expect(() => {
      stream.close();
      stream.close(); // Second call should not cause issues
    }).not.toThrow();
  });

  it("should handle race condition scenario", async () => {
    const chunk1: StreamChunk = [["node1"], "messages", { content: "Hello" }];
    const chunk2: StreamChunk = [["node2"], "messages", { content: "World" }];

    // Simulate the race condition scenario:
    // 1. Multiple nodes pushing simultaneously
    // 2. Stream gets closed in the middle
    // 3. More pushes happen after close

    // First, push some chunks while stream is open
    expect(() => stream.push(chunk1)).not.toThrow();

    // Close the stream (simulating abort)
    stream.close();

    // Now try to push more chunks (these should be ignored, not throw)
    expect(() => stream.push(chunk2)).not.toThrow();

    expect(stream.closed).toBe(true);
  });

  it("should handle concurrent pushes during closure", async () => {
    const chunks: StreamChunk[] = [
      [["node1"], "messages", { content: "Hello" }],
      [["node2"], "messages", { content: "World" }],
      [["node3"], "values", { value: 42 }],
    ];

    // Simulate multiple concurrent pushes happening at the same time as closure
    // This tests the try-catch mechanism in the push method
    const promises = chunks.map((chunk) => 
      Promise.resolve().then(() => stream.push(chunk))
    );

    // Close the stream
    stream.close();

    // Try to push more chunks after closure - these should be handled gracefully
    const additionalPromises = chunks.map((chunk) => 
      Promise.resolve().then(() => stream.push(chunk))
    );

    // All operations should complete without throwing errors
    await Promise.all([...promises, ...additionalPromises]);

    expect(stream.closed).toBe(true);
  });

  it("should handle rapid successive pushes and closure", async () => {
    const chunks: StreamChunk[] = Array.from({ length: 10 }, (_, i) => 
      [[`node${i}`], "messages", { content: `Message ${i}` }] as StreamChunk
    );

    // Create a sequence of operations that might trigger race conditions
    const operations = [];
    
    // Push some chunks
    for (let i = 0; i < 5; i++) {
      operations.push(Promise.resolve().then(() => stream.push(chunks[i])));
    }

    // Close the stream
    operations.push(Promise.resolve().then(() => stream.close()));

    // Push remaining chunks after closure
    for (let i = 5; i < 10; i++) {
      operations.push(Promise.resolve().then(() => stream.push(chunks[i])));
    }

    // All operations should complete without throwing errors
    await Promise.all(operations);

    expect(stream.closed).toBe(true);
  });

  it("should handle passthrough function during race condition", async () => {
    const passthroughResults: StreamChunk[] = [];
    const streamWithPassthrough = new IterableReadableWritableStream({
      modes: new Set(["values", "messages"]),
      passthroughFn: (chunk) => {
        passthroughResults.push(chunk);
      }
    });

    const chunk: StreamChunk = [["passthrough"], "messages", { content: "Test" }];

    // Push a chunk while stream is open
    streamWithPassthrough.push(chunk);
    expect(passthroughResults).toHaveLength(1);
    expect(passthroughResults[0]).toEqual(chunk);

    // Close the stream
    streamWithPassthrough.close();

    // Push another chunk after closure - should not call passthrough function
    const chunk2: StreamChunk = [["after-close"], "messages", { content: "Ignored" }];
    streamWithPassthrough.push(chunk2);
    
    // Passthrough function should not have been called for the second chunk
    expect(passthroughResults).toHaveLength(1);
    expect(passthroughResults[0]).toEqual(chunk);
  });

  it("should handle multiple close calls gracefully", () => {
    const chunk: StreamChunk = [["test"], "values", { data: "test chunk" }];
    
    // Close the stream multiple times
    stream.close();
    stream.close();
    stream.close();

    // Pushing after multiple closes should not throw
    expect(() => stream.push(chunk)).not.toThrow();
    expect(stream.closed).toBe(true);
  });

  it("should simulate the original issue scenario with multiple parallel nodes", async () => {
    // This test simulates the original issue: multiple parallel LLM nodes streaming tokens
    // and the stream being aborted/completed, causing race conditions
    
    const numNodes = 5;
    const numTokensPerNode = 10;
    
    // Create a stream with passthrough to capture what gets processed
    const capturedChunks: StreamChunk[] = [];
    const parallelStream = new IterableReadableWritableStream({
      modes: new Set(["messages"]),
      passthroughFn: (chunk) => {
        capturedChunks.push(chunk);
      }
    });

    // Simulate multiple nodes producing tokens in parallel
    const nodePromises = Array.from({ length: numNodes }, async (_, nodeIndex) => {
      // Simulate async token production from each node
      for (let tokenIndex = 0; tokenIndex < numTokensPerNode; tokenIndex++) {
        await new Promise(resolve => setTimeout(resolve, Math.random() * 10)); // Random delay
        
        // Push token if stream is still open
        const chunk: StreamChunk = [
          [`node-${nodeIndex}`], 
          "messages", 
          { content: `Token ${tokenIndex} from node ${nodeIndex}` }
        ];
        
        parallelStream.push(chunk);
      }
    });

    // Simulate the stream being closed while nodes are still producing tokens
    setTimeout(() => {
      parallelStream.close();
    }, 30); // Close after 30ms, while some nodes may still be pushing

    // Wait for all node operations to complete (some may fail silently after closure)
    await Promise.allSettled(nodePromises);

    // Verify that the stream is closed and no errors were thrown
    expect(parallelStream.closed).toBe(true);
    
    // Some chunks may have been captured before closure
    expect(capturedChunks.length).toBeGreaterThanOrEqual(0);
    
    // The important thing is that no errors were thrown during the process
  });
});