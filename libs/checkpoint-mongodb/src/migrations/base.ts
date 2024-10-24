import { SerializerProtocol } from "@langchain/langgraph-checkpoint";
import { Db, MongoClient } from "mongodb";

export interface MigrationParams {
  client: MongoClient;
  dbName: string;
  checkpointCollectionName: string;
  checkpointWritesCollectionName: string;
  schemaVersionCollectionName: string;
  serializer: SerializerProtocol;
  currentSchemaVersion: number;
}

export abstract class Migration {
  abstract version: number;

  protected client: MongoClient;

  protected dbName: string;

  protected checkpointCollectionName: string;

  protected checkpointWritesCollectionName: string;

  protected schemaVersionCollectionName: string;

  protected serializer: SerializerProtocol;

  protected currentSchemaVersion: number;

  private db: Db;

  constructor({
    client,
    dbName,
    checkpointCollectionName,
    checkpointWritesCollectionName,
    schemaVersionCollectionName,
    serializer,
    currentSchemaVersion,
  }: MigrationParams) {
    this.client = client;
    this.dbName = dbName;
    this.checkpointCollectionName = checkpointCollectionName;
    this.checkpointWritesCollectionName = checkpointWritesCollectionName;
    this.schemaVersionCollectionName = schemaVersionCollectionName;
    this.serializer = serializer;
    this.currentSchemaVersion = currentSchemaVersion;
    this.db = this.client.db(this.dbName);
  }

  abstract apply(): Promise<void>;

  async isApplicable(): Promise<boolean> {
    const versionDoc = await this.db
      .collection(this.schemaVersionCollectionName)
      .findOne({});

    if (!versionDoc || versionDoc.version === undefined) {
      return true;
    }

    const version = versionDoc.version as number;

    if (version < this.version) {
      return true;
    }

    return false;
  }
}

export class MigrationError extends Error {}
