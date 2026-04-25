# Kozane — Codebase Analysis

**Date:** 2026-04-25
**Stack:** SvelteKit 5 · Svelte 5 Runes · Drizzle ORM · libSQL (SQLite) · TypeScript 6 · Vite 8

---

## 1. Domain Model (Minimum Spec)

### Concepts

| Entity | Role |
|--------|------|
| **Project** | Top-level collection of bundles |
| **Bundle** | A named group of cards within a project |
| **Card** | Minimum unit of content; always belongs to one bundle |
| **Scope** | Cross-project card collection; gathers any cards regardless of project |
| **WorkingCopy** | A workspace attached to a scope; new cards can be created from it |
| **ScopeRel** | Many-to-many join table linking scopes to gathered cards |

### Hierarchy

```
Project
└── Bundle (project_id NOT NULL, cascade delete)
    └── Card (bundle_id NOT NULL, cascade delete)
        ├── workingCopyId (nullable, set null on wc delete)
        └── ScopeRel ──→ Scope
                              └── WorkingCopy (scope_id nullable, set null on scope delete)
```

### Delete behaviours

| Deleted | Effect on children |
|---------|--------------------|
| Project | Cascade → Bundle → Card → ScopeRel |
| Bundle | Cascade → Card → ScopeRel |
| Card | Cascade → ScopeRel |
| Scope | `working_copy.scope_id` set null (orphan working copy) |
| WorkingCopy | `card.working_copy_id` set null (card retained) |

### Card creation paths

1. **Plain card** — `addCard({ db, bundleId, content })` — no working copy association.
2. **Derived card** — `addCard({ db, bundleId, content, workingCopyId })` — created within a working copy context; the originating scope is traceable via `card → working_copy → scope`.

---

## 2. Source Structure

```
src/
├── app.d.ts              # SvelteKit App.Locals augmentation (injects DB type)
├── hooks.server.ts       # Attaches db singleton to every request's locals
├── db/
│   ├── client.ts         # DB singleton, DB type alias, withTx helper
│   ├── schema.ts         # Drizzle table + relation definitions
│   ├── internal/
│   │   └── config.ts     # DATABASE_URL env guard
│   ├── schema-types/     # Empty directory (placeholder)
│   └── api/
│       ├── types.ts      # Domain types: Project, Bundle, Card, Scope, WorkingCopy
│       ├── utils.ts      # assertFound helper
│       ├── project.ts    # CRUD: project
│       ├── bundle.ts     # CRUD: bundle  (projectId + bundleId access boundary)
│       ├── card.ts       # CRUD: card    (bundleId + cardId access boundary)
│       ├── scope.ts      # CRUD: scope   (cross-project, id-only entity)
│       ├── scope-rel.ts  # M:N ops: scope ↔ card
│       └── working-copy.ts # CRUD: working_copy + orphan listing
└── routes/
    ├── +layout.svelte    # Favicon, renders children
    ├── +page.server.ts   # load: listProjects
    └── +page.svelte      # Project list (Svelte 5 runes)
```

---

## 3. Type and Interface Relations

```
WithDB = { db: DB }                              (api/types.ts — used by project.ts, scope.ts)

BundleBase   = { db: DB; projectId: string }     (bundle.ts — local, mirrors WithDB)
CardBase     = { db: DB; bundleId: string }      (card.ts — local, mirrors WithDB)
WithScopeId  = { db: DB; scopeId: string }       (working-copy.ts — local)
ScopeRelBase = { db: DB; scopeId: string }       (scope-rel.ts — local)
ScopeRelKey  = { db: DB; scopeId: string; cardId: string }

Domain row types (InferSelectModel):
  Project, Bundle, Card, Scope, WorkingCopy      (api/types.ts)
  ScopeRel                                       ← NOT exported (gap)

DB = typeof db   (client.ts — full LibSQLDatabase<schema>)
```

---

## 4. API Function Map

All functions follow `async fn({ db, ...params }): Promise<T>`.

| Module | Functions |
|--------|-----------|
| `project.ts` | `listProjects`, `getProject`, `addProject`, `deleteProject`, `updateProjectName` |
| `bundle.ts` | `listBundles`, `getBundle`, `addBundle`, `deleteBundle`, `updateBundleName` |
| `card.ts` | `listCards`, `getCard`, `addCard`, `deleteCard`, `updateCardContent` |
| `scope.ts` | `listScopes`, `getScope`, `addScope`, `deleteScope` |
| `working-copy.ts` | `listWorkingCopies`, `listOrphanedWorkingCopies`, `addWorkingCopy`, `getWorkingCopy`, `deleteWorkingCopy` |
| `scope-rel.ts` | `listCardsByScope`, `addScopeRel` (idempotent), `removeScopeRel` |

---

## 5. Notable Design Patterns

### Access boundary on get/delete
`getBundle` and `deleteBundle` always filter by both `projectId` AND `bundleId`. Same for `getCard`/`deleteCard` with `bundleId`. This prevents horizontal privilege escalation via bare UUIDs.

### Soft-orphan on nullable FKs
`working_copy.scope_id` and `card.working_copy_id` are nullable with `onDelete: set null`. Rows are retained on parent deletion; `listOrphanedWorkingCopies` (filtering `isNull(scopeId)`) is the cleanup entry point.

### Idempotent many-to-many insert
`addScopeRel` uses `onConflictDoNothing()` — safe to call multiple times without error.

### Dependency injection via context object
The `db` handle is always passed explicitly as part of a `{ db, ...params }` argument. The singleton is never imported directly in API functions — they are all injectable and unit-testable without module mocking.

---

## 6. Pitfalls

| # | Location | Issue |
|---|----------|-------|
| 1 | `client.ts:13` | `(db as any).transaction(fn)` — `any` cast hides API changes at runtime; `Promise<T>` return masks it |
| 2 | `client.ts:5` | DB singleton initialises at import time; build steps without `DATABASE_URL` throw immediately |
| 3 | `scope.ts:7` | `listScopes` returns all scopes globally — unbounded, no pagination |
| 4 | `utils.ts:2` | `assertFound` throws plain `Error`; becomes a generic 500 in SvelteKit, not a typed 404 |
| 5 | `working-copy.ts` | No `updateWorkingCopy` — cannot re-link a working copy to a different scope |
| 6 | `schema.ts:22` | `scopeTable` has only `id` — no name, label, or any human-readable attribute |
| 7 | `card.ts:22` | `addCard` accepts arbitrary `workingCopyId` with no validation it belongs to the card's project context |
| 8 | `drizzle.config.ts:8` | Calls `getDBURL()` at config-parse time — `drizzle-kit generate` fails if `DATABASE_URL` unset |
| 9 | `bundle.ts:3` | Imports `DB` directly from `client` instead of `WithDB` from `types.ts` |
| 10 | `schema-types/` | Empty directory — likely planned but never implemented |

---

## 7. Domain-Level Design Gaps

### 7-1. Two card→scope relationships are semantically distinct but not unified

There are two independent paths by which a card relates to a scope:

- **Gathered**: `scope_rel (scopeId, cardId)` — an existing card is explicitly collected into a scope.
- **Originated**: `card.workingCopyId → working_copy.scopeId` — a card was created inside a working copy that belongs to a scope.

The schema does not distinguish these. A query "all cards belonging to scope X" requires a `UNION` of both paths. No such API function exists today, and creating a card from a working copy does NOT automatically insert a `scope_rel` row.

**Open question:** Should a card created from a working copy be auto-added to `scope_rel`? Or are "gathered" and "originated" intentionally separate?

### 7-2. `card.bundleId NOT NULL` creates a hidden placement decision at creation time

A card derived from a working copy still requires a `bundleId`. The working copy carries no target bundle. The caller must simultaneously resolve two independent concerns: (1) which scope context originated the card (working copy), and (2) which project/bundle stores it. These are orthogonal but both required at `addCard` time.

A higher-level composite function — e.g., `createCardFromWorkingCopy({ db, workingCopyId, bundleId, content })` — would make this contract explicit.

### 7-3. Scope deletion creates a two-level orphan chain

When a scope is deleted:
- `working_copy.scope_id → null` (orphan working copy — modeled)
- Cards born from that working copy still hold `workingCopyId` pointing to the now-orphaned working copy

A card can therefore have a `workingCopyId` whose working copy has `scopeId = null` — the card has silently lost its scope origin. `listOrphanedWorkingCopies` exposes the first level; there is no `listCardsWithOrphanedWorkingCopy` for the second.

### 7-4. Multiple working copies per scope — intent is undefined

The schema allows N working copies per scope (`workingCopyRelations` uses `many`). Currently `working_copy` has only `id` and `scopeId`. If multiple working copies represent multiple users' workspaces, there is no `userId`. If they represent sessions, there is no timestamp or label. The distinction between working copies of the same scope is not modelable.

### 7-5. No snapshot of scope contents at working-copy creation time

When a working copy is created, only `scopeId` is stored. The set of cards gathered in the scope at that moment is not recorded. As cards are later added to or removed from `scope_rel`, the working copy's implied "view" shifts. Whether a working copy should be a **live window** (current state of scope) or a **frozen snapshot** (state at creation time) is an architectural decision the schema does not encode.

### 7-6. No reverse path: scope → contributing projects

`listCardsByScope` returns cards for a scope, but there is no query for "which projects or bundles contribute cards to this scope?" — it requires `scope_rel → card → bundle → project`, a multi-join not covered by any current API function.

---

## 8. Improvement Points

### Types / Interfaces

1. **Standardise the base context type.** Four files define a local `{ db: DB; ... }` instead of extending `WithDB`. Consolidate in `types.ts`:
   ```ts
   export type WithProject = WithDB & { projectId: string };
   export type WithBundle  = WithDB & { bundleId: string };
   export type WithScope   = WithDB & { scopeId: string };
   ```

2. **Export `ScopeRel`.** Add `InferSelectModel<typeof scopeRelTable>` to `types.ts`.

3. **Fix the `withTx` type cast.** Replace `(db as any)` with a proper Drizzle transaction type:
   ```ts
   import type { LibSQLDatabase } from 'drizzle-orm/libsql';
   export async function withTx<T>(
     db: LibSQLDatabase<typeof schema>,
     fn: (tx: LibSQLDatabase<typeof schema>) => Promise<T>
   ): Promise<T> {
     return db.transaction(fn);
   }
   ```

### Implementations

4. **Typed `NotFoundError`:**
   ```ts
   export class NotFoundError extends Error {
     constructor(label: string) { super(`${label} not found`); this.name = 'NotFoundError'; }
   }
   ```
   Lets route handlers distinguish 404 from 500 via `instanceof`.

5. **Guard `drizzle.config.ts` against missing env var during schema generation:**
   ```ts
   url: process.env.DATABASE_URL ?? 'file:./sqlite/local.db',
   ```

6. **Wire `withTx` into multi-step operations.** `withTx` is defined but unused. Operations that span multiple tables (scope + working copy + card creation) should run inside a transaction.

7. **Add a composite `createCardFromWorkingCopy` function** that encapsulates the working-copy-id + bundle-id placement in one call.

### Design

8. **Add attributes to `scope` and `working_copy`.** At minimum: a `createdAt` timestamp; optionally a `label` for scope and a `userId`/`ownerId` for working copy.

9. **Decide and document the gathered vs. originated relationship.** Either auto-insert `scope_rel` on card creation from a working copy, or add an explicit API to query both paths.

10. **Add scope → projects reverse query** as a convenience function.

---

## 9. Learning Path

| Step | File | Goal |
|------|------|------|
| 1 | `src/db/schema.ts` | Understand the full data model and FK strategies |
| 2 | `drizzle/0000_nasty_slyde.sql` | Confirm schema intent at SQL level |
| 3 | `src/db/api/types.ts` | TypeScript domain types |
| 4 | `src/db/api/utils.ts` | Simplest shared helper |
| 5 | `src/db/api/project.ts` | Canonical full-CRUD pattern |
| 6 | `src/db/api/bundle.ts` | Access boundary pattern (projectId + bundleId) |
| 7 | `src/db/api/scope-rel.ts` | JOIN query + idempotent insert |
| 8 | `src/hooks.server.ts` → `src/routes/+page.server.ts` → `src/routes/+page.svelte` | Full SvelteKit data flow |
