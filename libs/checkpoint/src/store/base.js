"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseStore = void 0;
/**
 * Abstract base class for key-value stores.
 */
class BaseStore {
  /**
   * Execute a batch of operations.
   * @param _operations An array of operations to execute.
   * @returns A promise that resolves to the results of the operations.
   */
  async batch(_operations) {
    throw new Error("Method not implemented.");
  }
  // convenience methods
  /**
   * Retrieve a single item.
   * @param namespace Hierarchical path for the item.
   * @param id Unique identifier within the namespace.
   * @returns A promise that resolves to the retrieved item or null if not found.
   */
  async get(namespace, id) {
    const batchResult = await this.batch([{ namespace, id }]);
    return batchResult[0];
  }
  /**
   * Search for items within a namespace prefix.
   * @param namespacePrefix Hierarchical path prefix to search within.
   * @param options Search options.
   * @param options.filter Key-value pairs to filter results.
   * @param options.limit Maximum number of items to return (default: 10).
   * @param options.offset Number of items to skip before returning results (default: 0).
   * @returns A promise that resolves to a list of items matching the search criteria.
   */
  async search(namespacePrefix, options) {
    const optionsWithDefaults = {
      limit: 10,
      offset: 0,
      ...(options || {}),
    };
    const batchResults = await this.batch([
      { namespacePrefix, ...optionsWithDefaults },
    ]);
    return batchResults[0];
  }
  /**
   * Store or update an item.
   * @param namespace Hierarchical path for the item.
   * @param id Unique identifier within the namespace.
   * @param value Object containing the item's data.
   */
  async put(namespace, id, value) {
    await this.batch([{ namespace, id, value }]);
  }
  /**
   * Delete an item.
   * @param namespace Hierarchical path for the item.
   * @param id Unique identifier within the namespace.
   */
  async delete(namespace, id) {
    await this.batch([{ namespace, id, value: null }]);
  }
  /**
   * Stop the store. No-op if not implemented.
   */
  stop() {
    // no-op if not implemented.
  }
  /**
   * Start the store. No-op if not implemented.
   */
  start() {
    // no-op if not implemented.
  }
}
exports.BaseStore = BaseStore;
