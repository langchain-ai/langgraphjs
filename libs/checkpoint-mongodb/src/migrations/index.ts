import { Migration1ObjectMetadata } from "./1_object_metadata.js";
import { MigrationParams } from "./base.js";

function _getMigrations(params: MigrationParams) {
  const migrations = [Migration1ObjectMetadata];
  return migrations.map((MigrationClass) => new MigrationClass(params));
}

export async function needsMigration(params: MigrationParams) {
  const migrations = _getMigrations(params);
  return migrations.some((migration) => migration.isApplicable());
}

export async function applyMigrations(params: MigrationParams) {
  const migrations = _getMigrations(params);
  for (const migration of migrations) {
    if (await migration.isApplicable()) {
      await migration.apply();
    }
  }
}
