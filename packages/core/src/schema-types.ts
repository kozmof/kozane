export type SchemaValue = string | number | null;
export type SchemaRow = readonly SchemaValue[];
export type SchemaQuery = (sql: string) => Promise<readonly (readonly unknown[])[]>;
export interface SchemaIndex {
  readonly unique: SchemaValue;
  readonly origin: SchemaValue;
  readonly partial: SchemaValue;
  readonly columns: readonly SchemaRow[];
}
export interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly table: string;
  readonly sql: readonly string[] | null;
  readonly columns?: readonly (readonly (SchemaValue | readonly string[])[])[];
  readonly foreignKeys?: readonly SchemaRow[];
  readonly indexes?: readonly SchemaIndex[];
}
export type SchemaManifest = readonly SchemaObject[];
export interface SchemaComparison {
  readonly matches: boolean;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly altered: readonly string[];
}
