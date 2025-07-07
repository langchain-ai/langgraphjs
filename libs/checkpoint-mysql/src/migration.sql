CREATE TABLE IF NOT EXISTS checkpoint_migrations (
    v INT PRIMARY KEY COMMENT 'Migration version number, used to track database structure version'
) COMMENT 'Database migration version record table, used to manage database structure version control';

CREATE TABLE IF NOT EXISTS checkpoints (
    thread_id VARCHAR(150) NOT NULL COMMENT 'Thread ID, used to identify different execution threads',
    checkpoint_ns VARCHAR(150) NOT NULL DEFAULT '' COMMENT 'Checkpoint namespace, used to distinguish different types of checkpoints',
    checkpoint_id VARCHAR(150) NOT NULL COMMENT 'Checkpoint unique identifier',
    parent_checkpoint_id VARCHAR(150) COMMENT 'Parent checkpoint ID, used to build checkpoint hierarchy',
    type VARCHAR(150) COMMENT 'Checkpoint type, identifies the purpose of the checkpoint',
    checkpoint JSON NOT NULL COMMENT 'Checkpoint data, stores complete checkpoint state information',
    metadata JSON NOT NULL DEFAULT ('{}') COMMENT 'Metadata, stores additional information about the checkpoint',
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
) COMMENT 'Checkpoint main table, stores checkpoint data during LangGraph execution';

CREATE TABLE IF NOT EXISTS checkpoint_blobs (
    thread_id VARCHAR(150) NOT NULL COMMENT 'Thread ID, linked to checkpoint main table',
    checkpoint_ns VARCHAR(150) NOT NULL DEFAULT '' COMMENT 'Checkpoint namespace',
    channel VARCHAR(150) NOT NULL COMMENT 'Channel name, used to identify data channels',
    version VARCHAR(150) NOT NULL COMMENT 'Version number, used for version control',
    type VARCHAR(150) NOT NULL COMMENT 'Data type, identifies the type of blob data',
    `blob` LONGBLOB COMMENT 'Binary data, stores large binary objects',
    PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
) COMMENT 'Binary data table, stores checkpoint-related binary large object data';

CREATE TABLE IF NOT EXISTS checkpoint_writes (
    thread_id VARCHAR(150) NOT NULL COMMENT 'Thread ID, linked to checkpoint main table',
    checkpoint_ns VARCHAR(150) NOT NULL DEFAULT '' COMMENT 'Checkpoint namespace',
    checkpoint_id VARCHAR(150) NOT NULL COMMENT 'Checkpoint ID, linked to checkpoint main table',
    task_id VARCHAR(150) NOT NULL COMMENT 'Task ID, identifies specific execution tasks',
    idx INT NOT NULL COMMENT 'Index number, used to sort write operations',
    channel VARCHAR(150) NOT NULL COMMENT 'Channel name, identifies the channel for data writing',
    type VARCHAR(150) COMMENT 'Data type, identifies the type of data being written',
    `blob` LONGBLOB NOT NULL COMMENT 'Binary data, stores data to be written',
    PRIMARY KEY (
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        task_id,
        idx
    )
) COMMENT 'Write queue table, stores intermediate data to be written, supports asynchronous write operations';