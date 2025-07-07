import { DataTypes, Model, Sequelize } from "sequelize";

export class CheckpointMigration extends Model {
  declare v: number;
}

export class CheckpointModel extends Model {
  declare thread_id: string;

  declare checkpoint_ns: string;

  declare checkpoint_id: string;

  declare parent_checkpoint_id: string | null;

  declare type: string | null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare checkpoint: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare metadata: any;
}

export class CheckpointBlob extends Model {
  declare thread_id: string;

  declare checkpoint_ns: string;

  declare channel: string;

  declare version: string;

  declare type: string;

  declare blob: Buffer | null;
}

export class CheckpointWrite extends Model {
  declare thread_id: string;

  declare checkpoint_ns: string;

  declare checkpoint_id: string;

  declare task_id: string;

  declare idx: number;

  declare channel: string;

  declare type: string | null;

  declare blob: Buffer;
}

export function _initializeModels(sequelize: Sequelize) {
  // Initialize migration table model
  CheckpointMigration.init(
    {
      v: {
        type: DataTypes.INTEGER,
        primaryKey: true,
      },
    },
    {
      sequelize,
      modelName: "CheckpointMigration",
      tableName: "checkpoint_migrations",
      timestamps: false,
      freezeTableName: true,
    }
  );

  // Initialize checkpoint table model
  CheckpointModel.init(
    {
      thread_id: {
        type: DataTypes.STRING(150),
        allowNull: false,
        primaryKey: true,
      },
      checkpoint_ns: {
        type: DataTypes.STRING(150),
        allowNull: false,
        defaultValue: "",
        primaryKey: true,
      },
      checkpoint_id: {
        type: DataTypes.STRING(150),
        allowNull: false,
        primaryKey: true,
      },
      parent_checkpoint_id: {
        type: DataTypes.STRING(150),
        allowNull: true,
      },
      type: {
        type: DataTypes.STRING(150),
        allowNull: true,
      },
      checkpoint: {
        type: DataTypes.JSON,
        allowNull: false,
      },
      metadata: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: {},
      },
    },
    {
      sequelize,
      modelName: "Checkpoint",
      tableName: "checkpoints",
      timestamps: false,
      freezeTableName: true,
      indexes: [
        {
          name: "idx_checkpoints_pk",
          unique: true,
          fields: ["thread_id", "checkpoint_ns", "checkpoint_id"],
        },
      ],
    }
  );

  // Initialize checkpoint blob table model
  CheckpointBlob.init(
    {
      thread_id: {
        type: DataTypes.STRING(150),
        allowNull: false,
        primaryKey: true,
      },
      checkpoint_ns: {
        type: DataTypes.STRING(150),
        allowNull: false,
        defaultValue: "",
        primaryKey: true,
      },
      channel: {
        type: DataTypes.STRING(150),
        allowNull: false,
        primaryKey: true,
      },
      version: {
        type: DataTypes.STRING(150),
        allowNull: false,
        primaryKey: true,
      },
      type: {
        type: DataTypes.STRING(150),
        allowNull: false,
      },
      blob: {
        type: DataTypes.BLOB("long"),
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: "CheckpointBlob",
      tableName: "checkpoint_blobs",
      timestamps: false,
      freezeTableName: true,
      indexes: [
        {
          name: "idx_checkpoint_blobs_pk",
          unique: true,
          fields: ["thread_id", "checkpoint_ns", "channel", "version"],
        },
      ],
    }
  );

  // Initialize checkpoint write table model
  CheckpointWrite.init(
    {
      thread_id: {
        type: DataTypes.STRING(150),
        allowNull: false,
        primaryKey: true,
      },
      checkpoint_ns: {
        type: DataTypes.STRING(150),
        allowNull: false,
        defaultValue: "",
        primaryKey: true,
      },
      checkpoint_id: {
        type: DataTypes.STRING(150),
        allowNull: false,
        primaryKey: true,
      },
      task_id: {
        type: DataTypes.STRING(150),
        allowNull: false,
        primaryKey: true,
      },
      idx: {
        type: DataTypes.INTEGER,
        allowNull: false,
        primaryKey: true,
      },
      channel: {
        type: DataTypes.STRING(150),
        allowNull: false,
      },
      type: {
        type: DataTypes.STRING(150),
        allowNull: true,
      },
      blob: {
        type: DataTypes.BLOB("long"),
        allowNull: false,
      },
    },
    {
      sequelize,
      modelName: "CheckpointWrite",
      tableName: "checkpoint_writes",
      timestamps: false,
      freezeTableName: true,
      indexes: [
        {
          name: "idx_checkpoint_writes_pk",
          unique: true,
          fields: [
            "thread_id",
            "checkpoint_ns",
            "checkpoint_id",
            "task_id",
            "idx",
          ],
        },
      ],
    }
  );
}
