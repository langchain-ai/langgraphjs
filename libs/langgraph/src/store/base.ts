// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Values = Record<string, any>;

// todo: verify I can do camel case here instead of snake case and still have it be compatible with the deployed store
interface ItemData {
  value: Record<string, any>;
  // search metadata
  scores: Record<string, number>
  id: string;
  namespace: string[];
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date;
}

// TODO can I get away with just an object here and not a class?
class Item implements ItemData {
  value: Record<string, any>;
  scores: Record<string, number>
  id: string;
  namespace: string[];
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date;

  constructor(data: ItemData) {
    this.value = data.value;
    this.scores = data.scores;
    this.id = data.id;
    this.namespace = data.namespace;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
    this.lastAccessedAt = data.lastAccessedAt;
  }
}

interface GetOperation {
  namespace: string[];
  id: string;
}

interface SearchOperation {
  namespacePrefix: string[];
  filter?: Record<string, any>
  /**
   * @default 10
   */
  limit?: number;
  /**
   * @default 0
   */
  offset?: number;
}

interface PutOperation {
  namespace: string[];
  id: string;
  value: Record<string, any> | null;
}

type Operation = GetOperation | SearchOperation | PutOperation;

type OperationResults<Tuple extends readonly Operation[]> = {
  [K in keyof Tuple]: Tuple[K] extends PutOperation ? void :
  Tuple[K] extends SearchOperation ? Item[] :
  Tuple[K] extends GetOperation ? Item | null :
  never
}

export abstract class BaseStore {
    // abstract method

    abstract batch<Op extends Operation[]>(_operations: Op): Promise<OperationResults<Op>>;
  
    // convenience methods
  
    async get(namespace: string[], id: string): Promise<Item | null> {
      const batchResult = await this.batch([{ namespace, id }]);
      return batchResult[0] || null
    }
  
    async search(namespacePrefix: string[], options?: {
      filter?: Record<string, any>,
      /**
       * @default 10
       */
      limit?: number,
      /**
       * @default 0
       */
      offset?: number,
    }): Promise<Item[]> {
      const optionsWithDefaults = {
        limit: 10,
        offset: 0,
        ...(options || {}),
      };
      const batchResults = await this.batch([{ namespacePrefix, ...optionsWithDefaults }]);
      return batchResults[0];
    }
  
    async put(namespace: string[], id: string, value: Record<string, any>): Promise<void> {
     await this.batch([{ namespace, id, value }]);
    }
  
    async delete(namespace: string[], id: string): Promise<void> {
      await this.batch([{ namespace, id, value: null }]);
    }

  stop(): void {
    // no-op if not implemented.
  }

  start(): void {
    // no-op if not implemented.
  }
}
