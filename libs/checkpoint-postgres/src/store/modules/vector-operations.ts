import pg from "pg";
import { DatabaseCore } from "./database-core.js";
import { Embeddings } from "./types.js";

/**
 * Handles vector processing, embeddings, and text extraction.
 */
export class VectorOperations {
  constructor(private core: DatabaseCore) {}

  async indexItemVectors(
    client: pg.PoolClient,
    namespacePath: string,
    key: string,
    value: Record<string, unknown>,
    index?: string[] | false
  ): Promise<void> {
    // Early exit if vector indexing is not configured or explicitly disabled
    if (!this.core.indexConfig || index === false) return;

    // Delete existing vectors for this item
    await client.query(
      `
      DELETE FROM "${this.core.schema}".store_vectors 
      WHERE namespace_path = $1 AND key = $2
    `,
      [namespacePath, key]
    );

    // Use provided index fields if specified, otherwise use the configured default
    const fields = index || this.core.indexConfig.fields || ["$"];
    const textsToEmbed: { fieldPath: string; text: string }[] = [];

    // Extract text from configured fields
    for (const fieldPath of fields) {
      const extractedTexts = this.extractTextAtPath(value, fieldPath);
      extractedTexts.forEach((text, i) => {
        const trimmedText = text?.trim();
        if (trimmedText) {
          const actualFieldPath =
            extractedTexts.length > 1 ? `${fieldPath}[${i}]` : fieldPath;
          textsToEmbed.push({ fieldPath: actualFieldPath, text: trimmedText });
        }
      });
    }

    if (textsToEmbed.length === 0) return;

    // Generate embeddings
    const texts = textsToEmbed.map((item) => item.text);
    const embeddings = await this.generateEmbeddings(texts);

    // Insert vectors
    for (let i = 0; i < textsToEmbed.length; i += 1) {
      const { fieldPath, text } = textsToEmbed[i];
      const embedding = embeddings[i];

      if (embedding?.length === this.core.indexConfig.dims) {
        await client.query(
          `
          INSERT INTO "${this.core.schema}".store_vectors 
          (namespace_path, key, field_path, text_content, embedding)
          VALUES ($1, $2, $3, $4, $5)
        `,
          [namespacePath, key, fieldPath, text, `[${embedding.join(",")}]`]
        );
      }
    }
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.core.indexConfig) {
      throw new Error("Vector search not configured");
    }

    const { embed } = this.core.indexConfig;

    if (typeof embed === "function") {
      return await embed(texts);
    }

    // LangChain Embeddings interface
    if (embed && typeof embed === "object" && "embedDocuments" in embed) {
      return await (embed as Embeddings).embedDocuments(texts);
    }

    throw new Error("Invalid embedding configuration");
  }

  async generateQueryEmbedding(text: string): Promise<number[]> {
    if (!this.core.indexConfig) {
      throw new Error("Vector search not configured");
    }

    const { embed } = this.core.indexConfig;

    if (typeof embed === "function") {
      const embeddings = await embed([text]);
      return embeddings[0] || [];
    }

    // LangChain Embeddings interface
    if (embed && typeof embed === "object" && "embedQuery" in embed) {
      return await (embed as Embeddings).embedQuery(text);
    }

    if (embed && typeof embed === "object" && "embedDocuments" in embed) {
      const embeddings = await (embed as Embeddings).embedDocuments([text]);
      return embeddings[0] || [];
    }

    throw new Error("Invalid embedding configuration");
  }

  private extractTextAtPath(obj: unknown, path: string): string[] {
    if (path === "$") {
      return [JSON.stringify(obj)];
    }

    const parts = path.split(".");
    let current = obj;
    const results: string[] = [];

    try {
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];

        if (part.includes("[")) {
          const [field, arrayPart] = part.split("[");
          const arrayIndex = arrayPart.replace("]", "");

          if (field && typeof current === "object" && current !== null) {
            current = (current as Record<string, unknown>)[field];
          }

          if (arrayIndex === "*") {
            if (Array.isArray(current)) {
              const remainingPath = parts.slice(i + 1).join(".");

              if (remainingPath) {
                for (const item of current) {
                  if (item != null) {
                    results.push(
                      ...this.extractTextAtPath(item, remainingPath)
                    );
                  }
                }
              } else {
                for (const item of current) {
                  if (typeof item === "string") {
                    results.push(item);
                  } else if (typeof item === "object" && item !== null) {
                    results.push(JSON.stringify(item));
                  } else if (item != null) {
                    results.push(String(item));
                  }
                }
              }
            }
            return results;
          } else if (arrayIndex === "-1") {
            if (Array.isArray(current) && current.length > 0) {
              current = current[current.length - 1];
            }
          } else {
            const index = parseInt(arrayIndex, 10);
            if (
              Array.isArray(current) &&
              index >= 0 &&
              index < current.length
            ) {
              current = current[index];
            }
          }
        } else if (typeof current === "object" && current !== null) {
          current = (current as Record<string, unknown>)[part];
        }

        if (current == null) return [];
      }

      if (typeof current === "string") {
        results.push(current);
      } else if (typeof current === "object" && current !== null) {
        results.push(JSON.stringify(current));
      } else {
        results.push(String(current));
      }
    } catch (error) {
      return [];
    }

    return results;
  }
}
