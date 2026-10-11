/**
 * Kysely database type.
 *
 * Tables are declared here as migrations introduce them. Keeping the type
 * alongside the migration registry gives compile-time safety for every query.
 */
export interface DB {
  schema_migrations: SchemaMigrationsTable
  server_settings: ServerSettingsTable
}

export interface SchemaMigrationsTable {
  id: string
  applied_at: string
}

export interface ServerSettingsTable {
  key: string
  value: string
}
