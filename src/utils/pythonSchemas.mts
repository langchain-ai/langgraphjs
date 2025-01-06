/**
 * Represents a stored item with metadata.
 */
export interface PyItem {
  /**
   * The stored data as an object. Keys are filterable.
   */
  value: Record<string, any>;
  /**
   * Unique identifier within the namespace.
   */
  key: string;
  /**
   * Hierarchical path defining the collection in which this document resides.
   * Represented as an array of strings, allowing for nested categorization.
   * For example: ["documents", "user123"]
   */
  namespace: string[];
  /**
   * Timestamp of item creation.
   */
  created_at: Date;
  /**
   * Timestamp of last update.
   */
  updated_at: Date;
}
export type PyResult = PyItem | PyItem[] | string[][] | null | undefined;
