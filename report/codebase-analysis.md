# Kozane — Codebase Analysis

**Date:** 2026-04-25 (improvements applied 2026-04-25, 2026-04-26)
**Stack:** SvelteKit 5 · Svelte 5 Runes · Drizzle ORM · libSQL (SQLite) · TypeScript 6 · Vite 8

---

## 1. Domain Model (Minimum Spec)

### Concepts

| Entity          | Role                                                                   |
| --------------- | ---------------------------------------------------------------------- |
| **Project**     | Top-level collection of bundles                                        |
| **Bundle**      | A named group of cards within a project                                |
| **Card**        | Minimum unit of content; always belongs to one bundle                  |
| **Scope**       | Cross-project card collection; gathers any cards regardless of project |
| **WorkingCopy** | A workspace attached to a scope; new cards can be created from it      |
| **ScopeRel**    | Many-to-many join table linking scopes to gathered cards               |

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

| Deleted     | Effect on children                                     |
| ----------- | ------------------------------------------------------ |
| Project     | Cascade → Bundle → Card → ScopeRel                     |
| Bundle      | Cascade → Card → ScopeRel                              |
| Card        | Cascade → ScopeRel                                     |
| Scope       | `working_copy.scope_id` set null (orphan working copy) |
| WorkingCopy | `card.working_copy_id` set null (card retained)        |

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
│       ├── working-copy.ts # CRUD: working_copy + orphan listing (two levels)
│       └── composite.ts  # Cross-module: createCardFromWorkingCopy
└── routes/
    ├── +layout.svelte    # Favicon, renders children
    ├── +page.server.ts   # load: getAllProjects
    └── +page.svelte      # Project list (Svelte 5 runes)
```

---

## 3. Type and Interface Relations

```
WithDB      = { db: DB }                         (api/types.ts)
WithProject = WithDB & { projectId: string }     (api/types.ts — used by bundle.ts)
WithBundle  = WithDB & { bundleId: string }      (api/types.ts — used by card.ts)
WithScope   = WithDB & { scopeId: string }       (api/types.ts — used by working-copy.ts, scope-rel.ts)

ScopeRelKey = WithScope & { cardId: string }     (scope-rel.ts — local)

Domain row types (InferSelectModel):
  Project, Bundle, Card, Scope, ScopeRel, WorkingCopy   (api/types.ts)

DB = typeof db   (client.ts — full LibSQLDatabase<schema>)
Tx = LibSQLDatabase<typeof schema>               (client.ts — transaction handle, lacks `batch`)
```

---

## 4. API Function Map

All functions follow `async fn({ db, ...params }): Promise<T>`.

| Module            | Functions                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `project.ts`      | `getAllProjects`, `getProject`, `addProject`, `deleteProject`, `updateProjectName`                          |
| `bundle.ts`       | `getAllBundles`, `getBundle`, `addBundle`, `deleteBundle`, `updateBundleName`                               |
| `card.ts`         | `getAllCards`, `getCard`, `addCard`, `deleteCard`, `updateCardContent`                                      |
| `scope.ts`        | `getAllScopes`, `getScope`, `addScope`, `deleteScope`                                                       |
| `working-copy.ts` | `getAllWorkingCopies`, `getAllOrphanedWorkingCopies`, `getAllCardsWithOrphanedWorkingCopy`, `addWorkingCopy`, `getWorkingCopy`, `deleteWorkingCopy` |
| `scope-rel.ts`    | `getAllCardsByScope`, `addScopeRel` (idempotent), `removeScopeRel`                                          |
| `composite.ts`    | `createCardFromWorkingCopy` (transactional: addCard + auto addScopeRel)                                   |

---

## 5. Notable Design Patterns

### Access boundary on get/delete

`getBundle` and `deleteBundle` always filter by both `projectId` AND `bundleId`. Same for `getCard`/`deleteCard` with `bundleId`. This prevents horizontal privilege escalation via bare UUIDs.

### Soft-orphan on nullable FKs

`working_copy.scope_id` and `card.working_copy_id` are nullable with `onDelete: set null`. Rows are retained on parent deletion; `getAllOrphanedWorkingCopies` (filtering `isNull(scopeId)`) is the cleanup entry point.

### Idempotent many-to-many insert

`addScopeRel` uses `onConflictDoNothing()` — safe to call multiple times without error.

### Dependency injection via context object

The `db` handle is always passed explicitly as part of a `{ db, ...params }` argument. The singleton is never imported directly in API functions — they are all injectable and unit-testable without module mocking.

### Typed context hierarchy

Shared context types (`WithDB`, `WithProject`, `WithBundle`, `WithScope`) are defined centrally in `api/types.ts` and composed with intersection types (`WithProject = WithDB & { projectId: string }`). Per-module local aliases (e.g., `type BundleBase = WithProject`) keep call-site names readable without duplicating structure.

---

## 6. Pitfalls

| #   | Location                                                  | Status   | Issue                                                                                                                                                                                         |
| --- | --------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `client.ts`                                               | ✅ Fixed | `withTx` now calls `db.transaction()` on the typed `db`; only the callback argument carries a narrow `any` cast (documented). `Tx = LibSQLDatabase<typeof schema>` is the public-facing type. |
| 2   | `client.ts:5`                                             | open     | DB singleton initialises at import time; build steps without `DATABASE_URL` throw immediately                                                                                                 |
| 3   | `scope.ts:7`                                              | open     | `getAllScopes` returns all scopes globally — unbounded, no pagination                                                                                                                           |
| 4   | `utils.ts`                                                | ✅ Fixed | `assertFound` now throws `NotFoundError extends Error`; route handlers can distinguish 404 from 500 via `instanceof NotFoundError`.                                                           |
| 5   | `working-copy.ts`                                         | open     | No `updateWorkingCopy` — cannot re-link a working copy to a different scope                                                                                                                   |
| 6   | `schema.ts:22`                                            | open     | `scopeTable` has only `id` — no name, label, or any human-readable attribute                                                                                                                  |
| 7   | `card.ts`                                                 | open     | `addCard` accepts arbitrary `workingCopyId` with no validation it belongs to the card's project context                                                                                       |
| 8   | `drizzle.config.ts`                                       | ✅ Fixed | Now uses `process.env.DATABASE_URL ?? 'file:./sqlite/local.db'`; `drizzle-kit generate` works without a live DB.                                                                              |
| 9   | `bundle.ts`, `card.ts`, `working-copy.ts`, `scope-rel.ts` | ✅ Fixed | All local `{ db: DB; ... }` types replaced with `WithProject`, `WithBundle`, `WithScope` from `types.ts`. `DB` imports removed from consumer files.                                           |
| 10  | `schema-types/`                                           | open     | Empty directory — likely planned but never implemented                                                                                                                                        |

---

## 7. Domain-Level Design Gaps

### 7-1. Two card→scope relationships are semantically distinct but not unified — ✅ Fixed

There are two independent paths by which a card relates to a scope:

- **Gathered**: `scope_rel (scopeId, cardId)` — an existing card is explicitly collected into a scope.
- **Originated**: `card.workingCopyId → working_copy.scopeId` — a card was created inside a working copy that belongs to a scope.

`createCardFromWorkingCopy` (see 7-2) resolves this by auto-inserting a `scope_rel` row at card creation time when the working copy has a live scope. "Originated" and "gathered" are therefore unified at the point of creation; `getAllCardsByScope` captures both without a UNION.

### 7-2. `card.bundleId NOT NULL` creates a hidden placement decision at creation time — ✅ Fixed

`src/db/api/composite.ts` exports `createCardFromWorkingCopy({ db, workingCopyId, bundleId, content })`. It encapsulates both concerns — working-copy context and bundle placement — in a single transactional call. `addCard` remains the low-level primitive for plain card creation.

### 7-3. Scope deletion creates a two-level orphan chain — ✅ Fixed

When a scope is deleted:

- `working_copy.scope_id → null` (orphan working copy — modeled)
- Cards born from that working copy still hold `workingCopyId` pointing to the now-orphaned working copy

`getAllCardsWithOrphanedWorkingCopy({ db })` in `working-copy.ts` surfaces the second level via an inner join on `working_copy.scope_id IS NULL`. Use it alongside `getAllOrphanedWorkingCopies` for full orphan-chain cleanup.

### 7-4. Multiple working copies per scope — intent is undefined

The schema allows N working copies per scope (`workingCopyRelations` uses `many`). Currently `working_copy` has only `id` and `scopeId`. If multiple working copies represent multiple users' workspaces, there is no `userId`. If they represent sessions, there is no timestamp or label. The distinction between working copies of the same scope is not modelable.

### 7-5. No snapshot of scope contents at working-copy creation time

When a working copy is created, only `scopeId` is stored. The set of cards gathered in the scope at that moment is not recorded. As cards are later added to or removed from `scope_rel`, the working copy's implied "view" shifts. Whether a working copy should be a **live window** (current state of scope) or a **frozen snapshot** (state at creation time) is an architectural decision the schema does not encode.

### 7-6. No reverse path: scope → contributing projects

`getAllCardsByScope` returns cards for a scope, but there is no query for "which projects or bundles contribute cards to this scope?" — it requires `scope_rel → card → bundle → project`, a multi-join not covered by any current API function.

---

## 8. Improvement Points

### Types / Interfaces — ✅ Applied

1. ~~Standardise the base context type~~ — `WithProject`, `WithBundle`, `WithScope` added to `api/types.ts`; all consumer files updated.
2. ~~Export `ScopeRel`~~ — `ScopeRel = InferSelectModel<typeof scopeRelTable>` added to `api/types.ts`.
3. ~~Fix the `withTx` type cast~~ — `db` is now typed; callback cast is narrowed to `fn as any` with a comment explaining `SQLiteTransaction` lacks `batch`. Public `Tx` type exported from `client.ts`.

### Implementations — ✅ Applied

4. ~~Typed `NotFoundError`~~ — `NotFoundError extends Error` added to `api/utils.ts`; `assertFound` throws it.
5. ~~Guard `drizzle.config.ts`~~ — `process.env.DATABASE_URL ?? 'file:./sqlite/local.db'` inline; `getDBURL` import removed.
6. **Wire `withTx` into multi-step operations.** `withTx` is correctly typed and available. No composite operations exist yet — apply when the first multi-table write is introduced.
7. ~~Add a composite `createCardFromWorkingCopy` function~~ — `composite.ts` exports `createCardFromWorkingCopy`; auto-inserts `scope_rel` when working copy has a live scope.

### Design — open

8. **Add attributes to `scope` and `working_copy`.** At minimum: a `createdAt` timestamp; optionally a `label` for scope and a `userId`/`ownerId` for working copy.
9. ~~Decide and document the gathered vs. originated relationship~~ — resolved by auto-insert in `createCardFromWorkingCopy`; `getAllCardsByScope` now covers both paths.
10. **Add scope → projects reverse query** as a convenience function.

---

## 9. Learning Path

| Step | File                                                                             | Goal                                             |
| ---- | -------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1    | `src/db/schema.ts`                                                               | Understand the full data model and FK strategies |
| 2    | `drizzle/0000_nasty_slyde.sql`                                                   | Confirm schema intent at SQL level               |
| 3    | `src/db/api/types.ts`                                                            | TypeScript domain types                          |
| 4    | `src/db/api/utils.ts`                                                            | Simplest shared helper                           |
| 5    | `src/db/api/project.ts`                                                          | Canonical full-CRUD pattern                      |
| 6    | `src/db/api/bundle.ts`                                                           | Access boundary pattern (projectId + bundleId)   |
| 7    | `src/db/api/scope-rel.ts`                                                        | JOIN query + idempotent insert                   |
| 8    | `src/hooks.server.ts` → `src/routes/+page.server.ts` → `src/routes/+page.svelte` | Full SvelteKit data flow                         |
