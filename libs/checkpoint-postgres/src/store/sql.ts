interface STORE_TABLES {
  store: string;
  store_vectors: string;
  store_migrations: string;
}

export const getStoreTablesWithSchema = (schema: string): STORE_TABLES => {
  const tables = ["store", "store_vectors", "store_migrations"];
  return tables.reduce((acc, table) => {
    acc[table as keyof STORE_TABLES] = `"${schema}".${table}`;
    return acc;
  }, {} as STORE_TABLES);
};
