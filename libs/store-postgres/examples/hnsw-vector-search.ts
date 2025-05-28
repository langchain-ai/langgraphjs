/**
 * HNSW Vector Search Example
 * 
 * This example demonstrates the advanced vector search capabilities of the PostgreSQL store
 * using HNSW (Hierarchical Navigable Small World) indexes for high-performance similarity search.
 * 
 * Prerequisites:
 * - PostgreSQL with pgvector extension installed
 * - Connection string in environment variable POSTGRES_URL
 * 
 * Run with: npx tsx examples/hnsw-vector-search.ts
 */

import { PostgresStore } from "../src/index.js";

// Mock embedding function for demonstration
// In a real application, you would use a proper embedding model like OpenAI, Cohere, etc.
async function mockEmbeddingFunction(texts: string[]): Promise<number[][]> {
  return texts.map((text) => {
    // Create a simple hash-based embedding for demonstration
    const embedding = new Array(384).fill(0);
    for (let i = 0; i < text.length && i < 384; i += 1) {
      embedding[i] = Math.sin(text.charCodeAt(i) * 0.1) * 0.5 + 0.5;
    }
    // Normalize the embedding
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    return embedding.map(val => val / magnitude);
  });
}

async function main() {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) {
    console.error("Please set POSTGRES_URL environment variable");
    process.exit(1);
  }

  console.log("🚀 HNSW Vector Search Example");
  console.log("===============================\n");

  // Create store with HNSW vector index configuration
  const store = new PostgresStore({
    connectionOptions: connectionString,
    schema: "vector_demo",
    index: {
      dims: 384,
      embed: mockEmbeddingFunction,
      fields: ["content", "title"],
      indexType: 'hnsw',
      distanceMetric: 'cosine',
      hnsw: {
        m: 32,              // Higher connectivity for better recall
        efConstruction: 400, // Higher construction quality
        ef: 80              // Search quality parameter
      },
      createAllMetricIndexes: false // Only create cosine index
    }
  });

  try {
    console.log("📊 Setting up store with HNSW vector indexes...");
    await store.setup();

    // Sample documents for demonstration
    const documents = [
      {
        key: "ml-basics",
        value: {
          title: "Machine Learning Fundamentals",
          content: "Introduction to supervised learning, unsupervised learning, and neural networks. Covers basic algorithms like linear regression, decision trees, and k-means clustering.",
          category: "education",
          difficulty: "beginner",
          tags: ["machine-learning", "algorithms", "data-science"]
        }
      },
      {
        key: "deep-learning",
        value: {
          title: "Deep Learning with Neural Networks",
          content: "Advanced techniques in deep learning including convolutional neural networks, recurrent neural networks, and transformer architectures for computer vision and NLP.",
          category: "education", 
          difficulty: "advanced",
          tags: ["deep-learning", "neural-networks", "ai"]
        }
      },
      {
        key: "nlp-guide",
        value: {
          title: "Natural Language Processing Guide",
          content: "Comprehensive guide to NLP techniques including tokenization, named entity recognition, sentiment analysis, and language models like BERT and GPT.",
          category: "education",
          difficulty: "intermediate",
          tags: ["nlp", "language-models", "text-processing"]
        }
      },
      {
        key: "computer-vision",
        value: {
          title: "Computer Vision Applications",
          content: "Image processing, object detection, facial recognition, and medical imaging applications using convolutional neural networks and transfer learning.",
          category: "application",
          difficulty: "intermediate",
          tags: ["computer-vision", "image-processing", "cnn"]
        }
      },
      {
        key: "data-science",
        value: {
          title: "Data Science Workflow",
          content: "End-to-end data science process including data collection, cleaning, exploratory analysis, feature engineering, model training, and deployment.",
          category: "methodology",
          difficulty: "intermediate",
          tags: ["data-science", "workflow", "analytics"]
        }
      },
      {
        key: "ai-ethics",
        value: {
          title: "AI Ethics and Responsible AI",
          content: "Ethical considerations in AI development including bias detection, fairness, transparency, privacy, and the societal impact of artificial intelligence systems.",
          category: "ethics",
          difficulty: "beginner",
          tags: ["ai-ethics", "responsible-ai", "bias"]
        }
      }
    ];

    console.log("📝 Inserting sample documents...");
    for (const doc of documents) {
      await store.put(["ai-knowledge"], doc.key, doc.value);
      console.log(`   ✓ Inserted: ${doc.value.title}`);
    }

    console.log("\n🔍 Performing vector similarity searches...\n");

    // Example 1: Basic vector search
    console.log("1. Basic Vector Search - 'neural networks and deep learning'");
    console.log("   " + "=".repeat(60));
    const basicResults = await store.vectorSearch(
      ["ai-knowledge"],
      "neural networks and deep learning",
      {
        limit: 3,
        distanceMetric: 'cosine'
      }
    );

    basicResults.forEach((result, index) => {
      console.log(`   ${index + 1}. ${result.value.title} (score: ${result.score?.toFixed(3)})`);
      console.log(`      Category: ${result.value.category} | Difficulty: ${result.value.difficulty}`);
    });

    // Example 2: Vector search with filtering
    console.log("\n2. Filtered Vector Search - 'machine learning' + education category");
    console.log("   " + "=".repeat(60));
    const filteredResults = await store.vectorSearch(
      ["ai-knowledge"],
      "machine learning algorithms and techniques",
      {
        filter: {
          category: "education",
          difficulty: { $in: ["beginner", "intermediate"] }
        },
        limit: 3,
        similarityThreshold: 0.1
      }
    );

    filteredResults.forEach((result, index) => {
      console.log(`   ${index + 1}. ${result.value.title} (score: ${result.score?.toFixed(3)})`);
      console.log(`      Tags: ${result.value.tags.join(", ")}`);
    });

    // Example 3: Hybrid search (vector + text)
    console.log("\n3. Hybrid Search - 'computer vision' (70% vector, 30% text)");
    console.log("   " + "=".repeat(60));
    const hybridResults = await store.hybridSearch(
      ["ai-knowledge"],
      "computer vision and image processing",
      {
        vectorWeight: 0.7,
        similarityThreshold: 0.1,
        limit: 3
      }
    );

    hybridResults.forEach((result, index) => {
      console.log(`   ${index + 1}. ${result.value.title} (hybrid score: ${result.score?.toFixed(3)})`);
      console.log(`      Content preview: ${result.value.content.substring(0, 80)}...`);
    });

    // Example 4: Different distance metrics comparison
    console.log("\n4. Distance Metrics Comparison - 'artificial intelligence'");
    console.log("   " + "=".repeat(60));
    
    const metrics: Array<'cosine' | 'l2' | 'inner_product'> = ['cosine', 'l2', 'inner_product'];
    
    for (const metric of metrics) {
      console.log(`\n   ${metric.toUpperCase()} Distance:`);
      const metricResults = await store.vectorSearch(
        ["ai-knowledge"],
        "artificial intelligence and machine learning",
        {
          distanceMetric: metric,
          limit: 2
        }
      );
      
      metricResults.forEach((result, index) => {
        console.log(`     ${index + 1}. ${result.value.title} (${metric} score: ${result.score?.toFixed(3)})`);
      });
    }

    // Example 5: Advanced search with pagination
    console.log("\n5. Paginated Search - 'data science' with pagination");
    console.log("   " + "=".repeat(60));
    
    const page1 = await store.vectorSearch(
      ["ai-knowledge"],
      "data science and analytics",
      { limit: 2, offset: 0 }
    );
    
    const page2 = await store.vectorSearch(
      ["ai-knowledge"],
      "data science and analytics", 
      { limit: 2, offset: 2 }
    );

    console.log("   Page 1:");
    page1.forEach((result, index) => {
      console.log(`     ${index + 1}. ${result.value.title}`);
    });
    
    console.log("   Page 2:");
    page2.forEach((result, index) => {
      console.log(`     ${index + 1}. ${result.value.title}`);
    });

    // Example 6: Store statistics
    console.log("\n6. Store Statistics");
    console.log("   " + "=".repeat(60));
    const stats = await store.getStats();
    console.log(`   Total items: ${stats.totalItems}`);
    console.log(`   Namespaces: ${stats.namespaceCount}`);
    console.log(`   Oldest item: ${stats.oldestItem?.toISOString()}`);
    console.log(`   Newest item: ${stats.newestItem?.toISOString()}`);

    console.log("\n✨ HNSW Vector Search Demo Complete!");
    console.log("\nKey Benefits of HNSW over IVFFlat:");
    console.log("• Better recall and precision for high-dimensional data");
    console.log("• Faster query times, especially for approximate nearest neighbor search");
    console.log("• More consistent performance across different data distributions");
    console.log("• Better scalability for large datasets");
    console.log("• Configurable trade-offs between speed and accuracy");

  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await store.end();
  }
}

// Performance comparison function
async function performanceComparison() {
  console.log("\n🏁 Performance Comparison: HNSW vs IVFFlat");
  console.log("==========================================");
  
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) return;

  // HNSW store
  const hnswStore = new PostgresStore({
    connectionOptions: connectionString,
    schema: "perf_hnsw",
    index: {
      dims: 384,
      embed: mockEmbeddingFunction,
      indexType: 'hnsw',
      hnsw: { m: 16, efConstruction: 200, ef: 40 }
    }
  });

  // IVFFlat store
  const ivfStore = new PostgresStore({
    connectionOptions: connectionString,
    schema: "perf_ivf",
    index: {
      dims: 384,
      embed: mockEmbeddingFunction,
      indexType: 'ivfflat',
      ivfflat: { lists: 100, probes: 1 }
    }
  });

  try {
    await hnswStore.setup();
    await ivfStore.setup();

    // Insert test data
    const testData = Array.from({ length: 100 }, (_, i) => ({
      key: `doc${i}`,
      value: {
        title: `Document ${i}`,
        content: `This is test document number ${i} with various content about technology, science, and research topics.`
      }
    }));

    console.log("Inserting test data...");
    for (const data of testData) {
      await hnswStore.put(["test"], data.key, data.value);
      await ivfStore.put(["test"], data.key, data.value);
    }

    // Performance test
    const query = "technology and research topics";
    const iterations = 10;

    console.log(`\nRunning ${iterations} search iterations...`);

    // HNSW performance
    const hnswStart = Date.now();
    for (let i = 0; i < iterations; i += 1) {
      await hnswStore.vectorSearch(["test"], query, { limit: 10 });
    }
    const hnswTime = Date.now() - hnswStart;

    // IVFFlat performance  
    const ivfStart = Date.now();
    for (let i = 0; i < iterations; i += 1) {
      await ivfStore.vectorSearch(["test"], query, { limit: 10 });
    }
    const ivfTime = Date.now() - ivfStart;

    console.log(`HNSW average time: ${(hnswTime / iterations).toFixed(2)}ms`);
    console.log(`IVFFlat average time: ${(ivfTime / iterations).toFixed(2)}ms`);
    console.log(`Performance improvement: ${((ivfTime - hnswTime) / ivfTime * 100).toFixed(1)}%`);

  } finally {
    await hnswStore.end();
    await ivfStore.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => performanceComparison())
    .catch(console.error);
} 