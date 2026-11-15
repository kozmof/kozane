/** Test-only integration fixture. These tables and triggers are not the production log schema. */
import { is, sql } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../../../core/src/schema.js";
import { withTx, type DB, type Tx } from "../../../core/src/database.js";
import { configureActionConnection } from "../../../core/src/actions/connection.js";
import { captureRowSql, decodeCapturedRow } from "../../../core/src/actions/sql-codec.js";
import {
  createRowProjection,
  type ProjectionEffect,
  type ProjectionRow,
} from "../../../core/src/actions/projection.js";
import type {
  ActionExecutionRecord,
  ActionGroupResult,
} from "../../../core/src/actions/execution.js";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const capturedTables = Object.freeze(
  Object.values(schema)
    .filter((table) => is(table, SQLiteTable))
    .map((table) => {
      const config = getTableConfig(table);
      const primaryKey = [
        ...new Set([
          ...config.columns.filter((column) => column.primary).map((column) => column.name),
          ...config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)),
        ]),
      ];
      if (!primaryKey.length)
        throw new Error(`Capture fixture requires a primary key: ${config.name}`);
      return Object.freeze({
        name: config.name,
        columns: Object.freeze(config.columns.map((column) => column.name)),
        primaryKey: Object.freeze(primaryKey),
      });
    })
    .sort((a, b) => a.name.localeCompare(b.name)),
);

type Handle = DB | Tx;
export interface CapturedEffect extends ProjectionEffect {
  readonly actionId: string;
  readonly executionOrd: number;
}
export async function captureApplicationRows(db: Handle): Promise<ProjectionRow[]> {
  const output: ProjectionRow[] = [];
  for (const table of capturedTables) {
    const rows = await db.values(
      sql.raw(
        `SELECT ${captureRowSql(table.columns)} FROM ${quote(table.name)} ORDER BY ${table.primaryKey.map(quote).join(",")}`,
      ),
    );
    for (const row of rows) {
      if (typeof row[0] !== "string") throw new Error("Capture did not return a JSON image");
      output.push({ table: table.name, row: decodeCapturedRow(row[0]) });
    }
  }
  return output;
}
async function effects(db: Handle, runId: string): Promise<CapturedEffect[]> {
  const rows = await db
    .select({
      ord: sql<number>`ord`,
      table: sql<string>`tbl`,
      op: sql<"I" | "U" | "D">`op`,
      key: sql<string>`row_key`,
      before: sql<string | null>`before_image`,
      after: sql<string | null>`after_image`,
      actionId: sql<string>`action_id`,
      executionOrd: sql<number>`execution_ord`,
    })
    .from(sql`capture_effect`)
    .where(sql`run_id=${runId}`)
    .orderBy(sql`ord`);
  return rows.map((row) => ({
    ord: row.ord,
    table: row.table,
    op: row.op,
    key: decodeCapturedRow(row.key),
    before: row.before === null ? null : decodeCapturedRow(row.before),
    after: row.after === null ? null : decodeCapturedRow(row.after),
    actionId: row.actionId,
    executionOrd: row.executionOrd,
  }));
}
async function marker(db: Handle) {
  return db
    .select({
      runId: sql<string | null>`run_id`,
      actionId: sql<string | null>`action_id`,
      executionOrd: sql<number | null>`execution_ord`,
      nextEffectOrd: sql<number>`next_effect_ord`,
    })
    .from(sql`capture_context`);
}
async function runs(db: Handle) {
  return db
    .select({
      id: sql<string>`id`,
      rootId: sql<string>`root_id`,
      contractVersion: sql<number>`contract_ver`,
      complete: sql<number>`complete`,
      invocation: sql<string | null>`invocation`,
      generated: sql<string | null>`generated`,
    })
    .from(sql`capture_run`)
    .orderBy(sql`seq`);
}
async function executions(db: Handle, runId: string) {
  return db
    .select({
      id: sql<string>`action_id`,
      parentId: sql<string | null>`parent_id`,
      kind: sql<string>`kind`,
      contractVersion: sql<number>`contract_ver`,
      executionOrd: sql<number>`execution_ord`,
      input: sql<string>`input`,
      generated: sql<string | null>`generated`,
    })
    .from(sql`capture_execution`)
    .where(sql`run_id=${runId}`)
    .orderBy(sql`execution_ord`);
}
function empty(context: Awaited<ReturnType<typeof marker>>): boolean {
  return (
    context.length === 1 &&
    context[0].runId === null &&
    context[0].actionId === null &&
    context[0].executionOrd === null &&
    context[0].nextEffectOrd === 0
  );
}

export async function installCapturePrototype(db: DB) {
  const baseline = await withTx(db, async (tx) => {
    await configureActionConnection((statement) => tx.values(sql.raw(statement)));
    const baseline = await captureApplicationRows(tx);
    await tx.run(
      sql`CREATE TABLE capture_context(singleton INTEGER PRIMARY KEY CHECK(singleton=1),run_id TEXT,action_id TEXT,execution_ord INTEGER,next_effect_ord INTEGER NOT NULL DEFAULT 0)`,
    );
    await tx.run(sql`INSERT INTO capture_context(singleton) VALUES(1)`);
    await tx.run(
      sql`CREATE TABLE capture_run(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,root_id TEXT NOT NULL,contract_ver INTEGER NOT NULL,complete INTEGER NOT NULL DEFAULT 0,invocation TEXT,generated TEXT)`,
    );
    await tx.run(
      sql`CREATE TABLE capture_execution(run_id TEXT NOT NULL,action_id TEXT NOT NULL,parent_id TEXT,kind TEXT NOT NULL,contract_ver INTEGER NOT NULL,execution_ord INTEGER NOT NULL,input TEXT NOT NULL,generated TEXT,PRIMARY KEY(run_id,action_id),UNIQUE(run_id,execution_ord))`,
    );
    await tx.run(
      sql`CREATE TABLE capture_effect(run_id TEXT NOT NULL,ord INTEGER NOT NULL,action_id TEXT NOT NULL,execution_ord INTEGER NOT NULL,tbl TEXT NOT NULL,op TEXT NOT NULL,row_key TEXT NOT NULL,before_image TEXT,after_image TEXT,PRIMARY KEY(run_id,ord))`,
    );
    for (const table of capturedTables) {
      for (const [op, event] of [
        ["I", "INSERT"],
        ["U", "UPDATE"],
        ["D", "DELETE"],
      ] as const) {
        const valid = `EXISTS(SELECT 1 FROM capture_context c JOIN capture_run r ON r.id=c.run_id AND r.complete=0 JOIN capture_execution e ON e.run_id=c.run_id AND e.action_id=c.action_id AND e.execution_ord=c.execution_ord AND e.contract_ver=r.contract_ver WHERE c.singleton=1)`;
        const source = op === "D" ? "OLD" : "NEW";
        const before = op === "I" ? "NULL" : captureRowSql(table.columns, "OLD");
        const after = op === "D" ? "NULL" : captureRowSql(table.columns, "NEW");
        const changedKey = table.primaryKey
          .map((key) => `OLD.${quote(key)} IS NOT NEW.${quote(key)}`)
          .join(" OR ");
        await tx.run(
          sql.raw(`CREATE TRIGGER ${quote(`capture_${table.name}_${op}`)} BEFORE ${event} ON ${quote(table.name)} BEGIN
          SELECT CASE WHEN NOT ${valid} THEN RAISE(ABORT,'unstamped capture prototype write') END;
          ${op === "U" ? `SELECT CASE WHEN ${changedKey} THEN RAISE(ABORT,'capture prototype primary key changed') END;` : ""}
          INSERT INTO capture_effect SELECT run_id,next_effect_ord,action_id,execution_ord,'${table.name.replaceAll("'", "''")}','${op}',${captureRowSql(table.primaryKey, source)},${before},${after} FROM capture_context WHERE singleton=1;
          UPDATE capture_context SET next_effect_ord=next_effect_ord+1 WHERE singleton=1;
        END`),
        );
      }
    }
    return baseline;
  });

  async function verify(db: Handle) {
    let projection = createRowProjection(capturedTables, baseline);
    for (const run of await runs(db)) {
      if (run.complete !== 1) throw new Error("Incomplete capture run");
      projection = projection.apply(await effects(db, run.id));
    }
    const loaded = await captureApplicationRows(db);
    for (const table of capturedTables)
      projection.verifyInstalledRows(
        table.name,
        loaded.filter((row) => row.table === table.name).map((row) => row.row),
      );
    return projection;
  }

  function hooks(runId: string) {
    return {
      enter: async (tx: Tx, entry: Omit<ActionExecutionRecord, "generated">) => {
        const context = await marker(tx);
        if (entry.parentId === null) {
          if (!empty(context)) throw new Error("Capture root requires an empty marker");
          await tx.run(
            sql`INSERT INTO capture_run(id,root_id,contract_ver) VALUES(${runId},${entry.id},${entry.contractVersion})`,
          );
        } else if (
          context.length !== 1 ||
          context[0].runId !== runId ||
          context[0].actionId !== entry.parentId
        ) {
          throw new Error("Capture child marker does not match its parent");
        }
        await tx.run(
          sql`INSERT INTO capture_execution(run_id,action_id,parent_id,kind,contract_ver,execution_ord,input) VALUES(${runId},${entry.id},${entry.parentId},${entry.kind},${entry.contractVersion},${entry.executionOrd},${JSON.stringify(entry.input)})`,
        );
        await tx.run(
          sql`UPDATE capture_context SET run_id=${runId},action_id=${entry.id},execution_ord=${entry.executionOrd} WHERE singleton=1`,
        );
      },
      leave: async (tx: Tx, actionId: string, parentId: string | null) => {
        const context = await marker(tx);
        if (context.length !== 1 || context[0].runId !== runId || context[0].actionId !== actionId)
          throw new Error("Capture leave marker does not match the action");
        if (parentId === null) {
          await tx.run(
            sql`UPDATE capture_context SET run_id=NULL,action_id=NULL,execution_ord=NULL,next_effect_ord=0 WHERE singleton=1`,
          );
        } else {
          const [parent] = await tx
            .select({ ord: sql<number>`execution_ord` })
            .from(sql`capture_execution`)
            .where(sql`run_id=${runId} AND action_id=${parentId}`);
          if (!parent) throw new Error("Capture parent execution is missing");
          await tx.run(
            sql`UPDATE capture_context SET action_id=${parentId},execution_ord=${parent.ord} WHERE singleton=1`,
          );
        }
      },
      complete: async (tx: Tx, group: ActionGroupResult) => {
        if (!empty(await marker(tx)))
          throw new Error("Capture completion requires an empty marker");
        const captured = await effects(tx, runId);
        for (const [index, effect] of captured.entries()) {
          if (effect.ord !== index) throw new Error("Capture effect counter is discontinuous");
          await tx.run(
            sql`UPDATE capture_effect SET row_key=${JSON.stringify(effect.key)},before_image=${effect.before === null ? null : JSON.stringify(effect.before)},after_image=${effect.after === null ? null : JSON.stringify(effect.after)} WHERE run_id=${runId} AND ord=${effect.ord}`,
          );
        }
        if ((await executions(tx, runId)).length !== group.executions.length)
          throw new Error("Capture execution count differs from the scope");
        for (const entry of group.executions) {
          await tx.run(
            sql`UPDATE capture_execution SET input=${JSON.stringify(entry.input)},generated=${JSON.stringify(entry.generated)} WHERE run_id=${runId} AND action_id=${entry.id}`,
          );
        }
        await tx.run(
          sql`UPDATE capture_run SET complete=1,invocation=${JSON.stringify(group.invocation)},generated=${JSON.stringify(group.generated)} WHERE id=${runId}`,
        );
        await verify(tx);
      },
    };
  }
  return {
    baseline,
    hooks,
    effects: (runId: string) => effects(db, runId),
    executions: (runId: string) => executions(db, runId),
    runs: () => runs(db),
    marker: () => marker(db),
    verify: () => verify(db),
  };
}
