import { DatabaseCore } from "./database-core.js";

/**
 * Handles TTL (Time-To-Live) operations: expiration, cleanup, sweeping.
 */
export class TTLManager {
  private sweepInterval?: NodeJS.Timeout;

  constructor(private core: DatabaseCore) {}

  start(intervalMinutes: number = 60): void {
    if (this.sweepInterval) return; // Already running

    const intervalMs = intervalMinutes * 60 * 1000;
    this.sweepInterval = setInterval(() => {
      this.sweepExpiredItems().catch((error) => {
        console.error("Error during TTL sweep:", error);
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = undefined;
    }
  }

  async sweepExpiredItems(): Promise<number> {
    return this.core.withClient(async (client) => {
      const result = await client.query(`
        DELETE FROM "${this.core.schema}".store 
        WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP
      `);
      return result.rowCount || 0;
    });
  }
}
