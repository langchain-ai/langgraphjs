import { Binary, ObjectId, Collection, Document, WithId } from "mongodb";
import { CheckpointMetadata } from "@langchain/langgraph-checkpoint";
import { Migration, MigrationParams } from "./base.js";

const BULK_WRITE_SIZE = 100;

interface OldCheckpointDocument {
  parent_checkpoint_id: string | undefined;
  type: string;
  checkpoint: Binary;
  metadata: Binary;
  thread_id: string;
  checkpoint_ns: string | undefined;
  checkpoint_id: string;
}

interface NewCheckpointDocument {
  parent_checkpoint_id: string | undefined;
  type: string;
  checkpoint: Binary;
  metadata: CheckpointMetadata;
  thread_id: string;
  checkpoint_ns: string | undefined;
  checkpoint_id: string;
}

export class Migration1ObjectMetadata extends Migration {
  version = 1;

  constructor(params: MigrationParams) {
    super(params);
  }

  override async apply() {
    const db = this.client.db(this.dbName);
    const checkpointCollection = db.collection(this.checkpointCollectionName);
    const schemaVersionCollection = db.collection(
      this.schemaVersionCollectionName
    );

    // Fetch all documents from the checkpoints collection
    const cursor = checkpointCollection.find({});

    let updateBatch: {
      id: string;
      newDoc: NewCheckpointDocument;
    }[] = [];

    for await (const doc of cursor) {
      // already migrated
      if (!(doc.metadata._bsontype && doc.metadata._bsontype === "Binary")) {
        continue;
      }

      const oldDoc = doc as WithId<OldCheckpointDocument>;

      const metadata: CheckpointMetadata = await this.serializer.loadsTyped(
        oldDoc.type,
        oldDoc.metadata.value()
      );

      const newDoc: NewCheckpointDocument = {
        ...oldDoc,
        metadata,
      };

      updateBatch.push({
        id: doc._id.toString(),
        newDoc,
      });

      if (updateBatch.length >= BULK_WRITE_SIZE) {
        await this.flushBatch(updateBatch, checkpointCollection);
        updateBatch = [];
      }
    }

    if (updateBatch.length > 0) {
      await this.flushBatch(updateBatch, checkpointCollection);
    }

    // Update schema version to 1
    await schemaVersionCollection.updateOne(
      {},
      { $set: { version: 1 } },
      { upsert: true }
    );
  }

  private async flushBatch(
    updateBatch: {
      id: string;
      newDoc: NewCheckpointDocument;
    }[],
    checkpointCollection: Collection<Document>
  ) {
    if (updateBatch.length === 0) {
      throw new Error("No updates to apply");
    }

    const bulkOps = updateBatch.map(({ id, newDoc: newCheckpoint }) => ({
      updateOne: {
        filter: { _id: new ObjectId(id) },
        update: { $set: newCheckpoint },
      },
    }));

    await checkpointCollection.bulkWrite(bulkOps);
  }
}
