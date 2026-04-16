export const CREATE_CHECKPOINTS_TABLE = `
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint BLOB,
  metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);`;

export const CREATE_CHECKPOINT_BLOBS_TABLE = `
CREATE TABLE IF NOT EXISTS checkpoint_blobs (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL,
  version TEXT NOT NULL,
  type TEXT NOT NULL,
  blob BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
);`;

export const CREATE_CHANNEL_ITEMS_TABLE = `
CREATE TABLE IF NOT EXISTS channel_items (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  type TEXT NOT NULL,
  blob BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, channel, segment_id, idx)
);`;

export const CREATE_WRITES_TABLE = `
CREATE TABLE IF NOT EXISTS writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);`;
