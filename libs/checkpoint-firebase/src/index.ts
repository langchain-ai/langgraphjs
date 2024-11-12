import { Database, ref, set, get, query, orderByChild, limitToLast, startAt, runTransaction, endBefore, equalTo} from "firebase/database";
import type { RunnableConfig } from "@langchain/core/runnables";

import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
  type SerializerProtocol,
  type PendingWrite,
  type CheckpointMetadata,
  //type ChannelVersions,
  //WRITES_IDX_MAP,
  copyCheckpoint,
  CheckpointPendingWrite,
} from "@langchain/langgraph-checkpoint";

export class FirebaseSaver extends BaseCheckpointSaver {
    db: Database;
    checkpointCollectionName = "checkpoints";
    checkpointCollectionWritesName = "checkpoint_writes"
    
    constructor(
        db: Database,
        checkpointCollectionName?: string,
        checkpointWritesCollectionName?: string,
        serde?: SerializerProtocol
    ) {
        super(serde);
        this.db = db;
        this.checkpointCollectionName = 
            checkpointCollectionName ?? this.checkpointCollectionName;
        this.checkpointCollectionWritesName = 
            checkpointWritesCollectionName ?? this.checkpointCollectionWritesName;
    }

    async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
        const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {};
    
        if (!thread_id) {
            throw new Error(`Missing required fields in config.`);
        }
    
        let docRef;
        if (checkpoint_id) {
            // Fetch specific checkpoint by thread_id, checkpoint_ns, and checkpoint_id
            const docKey = `${thread_id}_${checkpoint_ns}_${checkpoint_id}`;
            docRef = ref(this.db, `${this.checkpointCollectionName}/${docKey}`);
        } else {
            // Query for the latest checkpoint by thread_id and checkpoint_ns
            const checkpointQuery = query(
                ref(this.db, `${this.checkpointCollectionName}`),
                orderByChild("thread_id_checkpoint_ns"), // Ensure a combined field if needed for querying efficiently
                startAt(`${thread_id}_${checkpoint_ns}`),
                limitToLast(1)
            );
            const snapshot = await get(checkpointQuery);
            if (!snapshot.exists()) return undefined;
    
            docRef = ref(this.db, `${this.checkpointCollectionName}/${Object.keys(snapshot.val())[0]}`);
        }
    
        // Fetch checkpoint data
        const snapshot = await get(docRef);
        if (!snapshot.exists()) return undefined;
    
        const checkpointData = snapshot.val();
        const checkpoint = this.serde.loadsTyped(checkpointData.type, checkpointData.checkpoint) as Checkpoint;
        const metadata = this.serde.loadsTyped(checkpointData.type, checkpointData.metadata) as CheckpointMetadata;
    
        // Retrieve serialized writes if any
        const serializedWritesQuery = query(
            ref(this.db, this.checkpointCollectionWritesName),
            orderByChild("thread_id_checkpoint_ns_checkpoint_id"),
            startAt(`${thread_id}_${checkpoint_ns}_${checkpoint_id ?? checkpointData.checkpoint_id}`)
        );
        const writesSnapshot = await get(serializedWritesQuery);
        const pendingWrites = [];
        if (writesSnapshot.exists()) {
            for (const writeKey in writesSnapshot.val()) {
                const write = writesSnapshot.val()[writeKey];
                const pendingWrite = [
                    write.task_id,
                    write.channel,
                    await this.serde.loadsTyped(write.type, write.value),
                ] as CheckpointPendingWrite;
                pendingWrites.push(pendingWrite);
            }
        }
    
        // Check for parent checkpoint
        const parentConfig =
            checkpointData.parent_checkpoint_id != null
                ? {
                      configurable: {
                          thread_id,
                          checkpoint_ns,
                          checkpoint_id: checkpointData.parent_checkpoint_id,
                      },
                  }
                : undefined;
    
        return {
            config,
            checkpoint,
            pendingWrites,
            metadata,
            parentConfig,
        };
    }
    
    
    async *list(
        config: RunnableConfig,
        options?: CheckpointListOptions
      ): AsyncGenerator<CheckpointTuple> {
        const { limit, before, filter } = options ?? {};
        const thread_id = config?.configurable?.thread_id;
        const checkpoint_ns = config?.configurable?.checkpoint_ns ?? "";
      
        if (!thread_id) {
          throw new Error("Missing required thread_id in config.");
        }
      
        const listRef = ref(this.db, this.checkpointCollectionName);
        const queryConstraints: any[] = [];
      
        // Add thread_id and checkpoint_ns filters
        queryConstraints.push(orderByChild("thread_id"));
        queryConstraints.push(equalTo(thread_id));
      
        if (checkpoint_ns) {
          queryConstraints.push(orderByChild("checkpoint_ns"));
          queryConstraints.push(equalTo(checkpoint_ns));
        }
      
        // Apply metadata filter
        if (filter) {
          Object.entries(filter).forEach(([key, value]) => {
            queryConstraints.push(orderByChild(`metadata.${key}`));
            queryConstraints.push(equalTo(value));
          });
        }
      
        // Apply 'before' constraint to checkpoint_id
        if (before) {
          queryConstraints.push(orderByChild("checkpoint_id"));
          queryConstraints.push(endBefore(before.configurable?.checkpoint_id));
        }
      
        // Limit results if specified
        if (limit !== undefined) {
          queryConstraints.push(limitToLast(limit));
        }
      
        const queryRef = query(listRef, ...queryConstraints);
        const snapshot = await get(queryRef);
      
        // Iterate over results and yield each checkpoint
        if (snapshot.exists()) {
          const data = snapshot.val();
          for (const key in data) {
            const item = data[key];
            const checkpoint = this.serde.loadsTyped(item.type, item.checkpoint) as Checkpoint;
            const metadata = this.serde.loadsTyped(item.type, item.metadata) as CheckpointMetadata;
      
            yield {
              config: {
                configurable: {
                  thread_id: item.thread_id,
                  checkpoint_ns: item.checkpoint_ns,
                  checkpoint_id: item.checkpoint_id,
                },
              },
              checkpoint,
              metadata,
              parentConfig: item.parent_checkpoint_id
                ? {
                    configurable: {
                      thread_id: item.thread_id,
                      checkpoint_ns: item.checkpoint_ns,
                      checkpoint_id: item.parent_checkpoint_id,
                    },
                  }
                : undefined,
            };
          }
        }
      }
      
    
    /* Save a checkpoint to the Firestore database */
    async put(
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata
    ): Promise<RunnableConfig> {
        if (!config.configurable) {
            throw new Error("Empty configuration supplied.");
        }

        const thread_id = config.configurable?.thread_id;
        const checkpoint_ns = config.configurable?.checkpoint_ns ?? "";
        const parent_checkpoint_id = config.configurable?.checkpoint_id;

        if (!thread_id) {
        throw new Error(
            `Missing "thread_id" field in passed "config.configurable".`
            );
        }

        /* SQLite implementation does this, while MongoDB does not.
            If possible, I would like to figure out why we use a copy
            of the checkpoint, instead of the original one to source
            our values for storage */

        const preparedCheckpoint: Partial<Checkpoint> = copyCheckpoint(checkpoint);
        delete preparedCheckpoint.pending_sends;

        const [type1, serializedCheckpoint] =
            this.serde.dumpsTyped(preparedCheckpoint);
        
        const [type2, serializedMetadata] = 
            this.serde.dumpsTyped(metadata);
        
        if (type1 !== type2){
            throw new Error(
                "Failed to serialized checkpoint and metadata to the same type."
            );
        }

        /* We want to store the following (taken from MongoDB implementation)
            - checkpoint ID
            - checkpoint type
            - checkpoint (serialized)
            - metadata (serialized)*/

        /* SQLite implementation also stores the following
            - parent checkpoint ID
            - thread ID,
            - checkpoint_ns, */

        /* I believe the excess values are stored for debugging purposes (hunch)
            I am going to store the excess values as well here */

        const data = {
            thread_id: thread_id,
            checkpoint_ns: checkpoint_ns,
            checkpoint_id: checkpoint.id,
            parent_checkpoint_id: parent_checkpoint_id,
            type: type1,
            checkpoint: serializedCheckpoint,
            metadata: serializedMetadata
            };

        /* "thread_id", "checkpoint_ns", and "checkpoint_id" 
            form the "primary key" for this database */
        const docKey = `${thread_id}_${checkpoint_ns}_${checkpoint.id}`;

        /* Get a reference to the location in the database 
           where you want to store the data */
        const dataRef = ref(this.db, `${this.checkpointCollectionName}/${docKey}`);

        /* Use set to write the data to this reference */
        await set(dataRef, data);

        return {
            configurable: {
                thread_id,
                checkpoint_ns,
                checkpoint_id: checkpoint.id,
            },
        };
    }

    /* Saves intermediate writes associated with a checkpoint to the Firestore database. */
    async putWrites(
        config: RunnableConfig,
        writes: PendingWrite[],
        taskId: string
    ): Promise<void> {
        if (!config.configurable) {
            throw new Error("Empty configuration supplied.");
          }
      
        if (!config.configurable?.thread_id) {
            throw new Error("Missing thread_id field in config.configurable.");
        }
    
        if (!config.configurable?.checkpoint_id) {
            throw new Error("Missing checkpoint_id field in config.configurable.");
        }

        const thread_id = config.configurable?.thread_id;
        const checkpoint_ns = config.configurable?.checkpoint_ns ?? "";
        const checkpoint_id = config.configurable?.checkpoint_id;

        const dataRef = ref(this.db, `${this.checkpointCollectionName}`);

        runTransaction(dataRef, (currentData) => {
            writes.forEach((write, idx) => {
                const [channel, value] = write;
                const [type, serializedValue] = this.serde.dumpsTyped(value);
    
                /* "thread_id", "checkpoint_ns", "checkpoint_id", "taskId" and "idx"
                    form the "primary key" for each checkpoint write */
                const writeKey = `${thread_id}_${checkpoint_ns}_${checkpoint_id}_${taskId}_${idx}`;
                
                currentData[writeKey] = {
                    thread_id: thread_id,
                    checkpoint_ns: checkpoint_ns,
                    checkpoint_id: checkpoint_id,
                    taskId: taskId,
                    idx: idx,
                    channel: channel,
                    type: type,
                    serializedWrite: serializedValue
                };
            });
            return currentData
        });            
    }
}