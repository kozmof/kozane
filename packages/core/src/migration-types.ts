/** A bundled migration, preserving its original journal metadata and SQL bytes. */
export interface MigrationRecord {
  readonly id: string;
  readonly tag: string;
  readonly idx: number;
  readonly version: string;
  readonly when: number;
  readonly breakpoints: boolean;
  readonly sql: string;
  readonly hash: string;
  readonly statements: readonly string[];
}
export type MigrationHistoryMode = "prefix" | "complete";
/** Normalized history rows read from the candidate database, ordered by created_at. */
export interface MigrationHistoryRow {
  readonly hash: string;
  readonly created_at: number | bigint | string;
}
export interface MigrationHistoryValidation {
  readonly appliedCount: number;
  readonly complete: boolean;
  readonly pending: readonly MigrationRecord[];
}

export interface MigrationApplicationResult {
  readonly schemaVersion: string;
  readonly appliedIds: readonly string[];
}
