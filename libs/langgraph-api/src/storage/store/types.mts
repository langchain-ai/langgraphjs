import { 
    InMemoryStore as BaseMemoryStore,
    type Operation,
    type OperationResults
} from "@langchain/langgraph";

export interface Store {
    initialize(cwd: string): Promise<Store>;
    clear(): Promise<void> | void;
    batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>>;
    get(...args: Parameters<BaseMemoryStore["get"]>): ReturnType<BaseMemoryStore["get"]>;
    search(...args: Parameters<BaseMemoryStore["search"]>): ReturnType<BaseMemoryStore["search"]>;
    put(...args: Parameters<BaseMemoryStore["put"]>): ReturnType<BaseMemoryStore["put"]>;
    listNamespaces(...args: Parameters<BaseMemoryStore["listNamespaces"]>): ReturnType<BaseMemoryStore["listNamespaces"]>;
}