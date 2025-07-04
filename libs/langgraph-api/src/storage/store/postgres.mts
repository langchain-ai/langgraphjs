import { PostgresStore as CorePostgresStore } from "@langchain/store-postgres";
import { Store } from "./types.mjs";

export class PostgresStore extends CorePostgresStore implements Store {
    async initialize(cwd: string) {
        console.log(`doing initialize on postgres store`)
        await this.setup();
        return this;
    }

    async clear(): Promise<void> {
        // Use the 'core' property which is a DatabaseCore instance
        // @ts-ignore - We know 'core' exists and has the withClient method  
        if (this.core && this.core.withClient) {
            return await this.core.withClient(async (client: any) => {
                try {
                    // @ts-ignore - Access schema from core
                    const schema = this.core.schema;
                    
                    // Check what tables exist first
                    const tableResult = await client.query(`
                        SELECT table_name 
                        FROM information_schema.tables 
                        WHERE table_schema = $1 AND table_name LIKE '%store%'
                    `, [schema]);
                    
                    const tableNames = tableResult.rows.map((r: any) => r.table_name);
                    
                    // Only delete from tables that actually exist
                    if (tableNames.length === 0) {
                        return;
                    }
                    
                    await client.query('BEGIN');
                    
                    if (tableNames.includes('store')) {
                        await client.query(`DELETE FROM ${schema}.store`);
                    }
                    
                    if (tableNames.includes('store_vectors')) {
                        await client.query(`DELETE FROM ${schema}.store_vectors`);
                    }
                    
                    await client.query('COMMIT');
                    
                } catch (error) {
                    try {
                        await client.query('ROLLBACK');
                    } catch (rollbackError) {
                        // Ignore rollback errors
                    }
                    throw error;
                }
            });
        }
        
        throw new Error("PostgresStore.clear: core.withClient not available");
    }

    async flush() {
        return Promise.resolve(true);
    }
}