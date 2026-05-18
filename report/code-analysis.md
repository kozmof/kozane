# Kozane — Code Analysis

_Generated: 2026-05-18_

## 1. Code Organization and Structure

The project has a clean 3-layer separation:

```
CLI (src/cli/)                   — commander-based, spawns the SvelteKit server
DB API (src/db/)                 — schema, client, and per-entity data-access functions
Web (src/routes/ + src/lib/)     — SvelteKit page/API routes, UI components, and state
```

This separation holds well in practice. The DB API never imports from routes; the CLI commands drive the DB API directly. `src/db/api/composite.ts` correctly isolates multi-step transactional operations from single-entity modules, keeping each module focused.

`project-actions.svelte.ts` centralizes all client-side action handlers, making the main page component act as a thin wiring layer between state and actions. This is a good pattern for Svelte 5's runes world.

---

## 2. Type/Interface Relations

Two type systems run in parallel:

| Location | Purpose | Source |
|---|---|---|
| `src/db/api/types.ts` | Server-side DB row types | `InferSelectModel<typeof table>` |
| `src/lib/types.ts` | Frontend domain types | Manually written interfaces |

The DB-side `WorkingCopy` has all 9 fields; the frontend `WorkingCopy` deliberately exposes only `{id, name, scopeId, path}` — this narrowing is done explicitly in `+page.server.ts` with a `.map()` pick. That is intentional and sound.

The `NeedsDB / NeedsProject / NeedsBundle / NeedsScope / NeedsWorkingCopy` composition types create a consistent, named parameter-object pattern across all DB API functions. Clean.

The branded types in `tx.ts` (`DB`, `Tx`, `AnyDB`) enforce transaction context at the type level — functions that start a transaction take `DB`, inner logic takes `AnyDB`, and `withTx` bridges them. This is the most sophisticated design choice in the codebase and it works correctly.

One subtle issue: `NeedsWorkingCopy` is defined in `types.ts` but the functions in `working-copy.ts` use inline `{ db, workingCopyId }` shapes rather than importing it. It goes unused.

---

## 3. Function Relations

The main data flow for a page load:

```
+page.server.ts (load)
  → getProject / getAllBundles / getAllScopes         (parallel)
  → getCardsByBundles(bundleIds)
  → getGlueRelsByCards / getScopeRelsByCards / getWorkingCopiesByProject  (parallel)
  → cardsWithGlueIds(cards, glueRels)                (in-memory join)
  → return to page
```

The two-round sequential structure is forced by the fact that `bundleIds` depend on `getAllBundles` and `cardIds` depend on the card fetch. The parallel calls inside each round are already well-exploited via `Promise.all`.

The glue lifecycle: `glueCards` → `withTx` → `glueCardsCore` → `dissolveOrphanGroups`. The private `dissolveOrphanGroups` function only accepts `AnyDB`, meaning it can only run inside a transaction context. This is correct.

**Ownership join duplication**: The `bundle ⋈ card` join to verify project ownership appears independently in five places: `updateProjectCardPositions`, `addScopeMembers`, `removeScopeMembersFromProject`, `requireCardInProject`, and `allCardsBelongToProject`.

---

## 4. Specific Contexts and Usages

**`createCardInWorkingCopyContext`** is exported specifically for testability (bypasses the `withTx` wrapper) and is clearly documented with a comment warning against direct production use. This is a good pattern for keeping test setup simple without sacrificing production correctness.

**`addScopeRel`** uses `onConflictDoNothing()` for idempotency — the function is safe to call multiple times. This is used in `createCardInWorkingCopyContext` where a race is conceivable.

**`glueCardsCore`**: When re-glueing already-glued cards, it first dissolves their old group memberships, then creates a fresh group. This means glueing A+B then glueing B+C results in a new group {B, C} — A is left ungrouped. That is the designed behavior.

**Canvas coordinate math** in `KozaneCanvas.svelte`: The zoom-aware scroll-to-world conversion uses the scroll offset plus client offset, divided by zoom. The inverse is used for zoom-on-cursor in the wheel handler (adjusting `scrollLeft`/`scrollTop` so the point under the cursor stays fixed). Both are correct.

---

## 5. Pitfalls

**1. Top-level `await` in `client.ts`**

```ts
const client = createClient({ url: getDBURL() });
await client.execute("PRAGMA foreign_keys = ON");  // module-level side effect
export const db = ...;
```

This runs once at module initialization. Any test that transitively imports `client.ts` will open a real DB connection and run a PRAGMA — even if the test has its own in-memory DB. The test setup needs to carefully avoid importing `client.ts`.

**2. `handleSelectionBundleChange` issues N parallel requests**

(`src/routes/[projectId]/project-actions.svelte.ts:67-80`)

```ts
const results = await Promise.all(
  cardIds.map((id) => api.updateCard(..., id, { bundleId: newBundleId })),
);
```

For 50 selected cards this fires 50 HTTP requests in parallel. Each request hits the DB separately with no transaction — partial failure leaves cards in mixed states (some moved, some not). The error check only surfaces that _something_ failed, not which cards.

**3. `glueGroupIds` is O(n) × O(n) per call**

(`src/routes/[projectId]/lib/project-page.ts:43-47`)

```ts
const rel = glueRels.find((r) => r.cardId === cardId);
return glueRels.filter((r) => r.glueId === rel.glueId).map(...);
```

Called once per card in the selection rect loop (`applyRectangleSelection`) — potentially O(cards × glueRels) if many cards are selected.

**4. `BundleWithColor.isDefault` is optional**

(`src/lib/types.ts:18-25`)

```ts
interface BundleWithColor { isDefault?: boolean; }  // optional
interface Bundle          { isDefault: boolean; }    // required
```

Since `applyPalette` spreads a `Bundle` into `BundleWithColor`, the field is always present at runtime. Code that checks `isDefault` on a `BundleWithColor` may silently treat `undefined` as falsy if the type is used directly.

**5. `scopeTable.name` defaults to `""`**

(`src/db/schema.ts:37`)

Anonymous scopes (empty string name) can be created. The schema alone does not enforce a non-empty name.

**6. Card has no timestamps**

`cardTable` has no `createdAt`/`updatedAt` columns while `workingCopyTable` does. Ordering cards by creation time or detecting stale data is not possible without adding them.

---

## 6. Improvement Points — Design Overview

**Batch bundle-reassignment endpoint**

Replace the N-parallel-requests pattern in `handleSelectionBundleChange` with a `PATCH /cards` endpoint that accepts `[{cardId, bundleId}]` pairs wrapped in a single transaction. This eliminates partial-failure risk and reduces latency.

**Ownership join as a shared utility**

The project-ownership JOIN (`card → bundle → project`) is repeated in five places. The function `allCardsBelongToProject` already exists in `guards.ts` but is only called from route handlers; the DB-layer functions re-implement it inline. Lifting it into the DB API layer as a shared function would remove the duplication.

**Page load query structure**

The load function in `+page.server.ts` does three sequential async steps. Using a single JOIN query or restructuring the dependencies could collapse this to two steps, reducing latency on slow connections.

**Working copy scan as a background job**

`wc-scan.ts` is only triggered from the CLI. There is no automatic background sync when the server is running. A periodic background scan (or file-watcher) would keep `lastSeenAt` and path accuracy current without manual `kozane wc scan` invocations.

---

## 7. Improvement Points — Types and Interfaces

**`CardData` mixes stored and computed fields**

`glueId` in `CardData` is not a DB column — it is joined in via `cardsWithGlueIds`. The type mixes stored and derived data. `CardWithGlue` in `project-page.ts` already models this correctly; `CardData` in `$lib/types.ts` is a parallel definition that can drift from it.

**`NeedsWorkingCopy` is declared but unused**

(`src/db/api/types.ts:18`)

Either use it in `working-copy.ts` function signatures or remove it.

**`WorkingCopy` frontend subset could be a `Pick`**

The frontend `WorkingCopy` interface mirrors `Pick<DbWorkingCopy, 'id' | 'name' | 'scopeId' | 'path'>`. A shared type alias would prevent drift if a column is renamed.

**`BundleWithColor.isDefault` should be required**

Since `applyPalette` always spreads a `Bundle` (which has `isDefault: boolean`), the resulting `BundleWithColor` always has the field. The interface should reflect this with `isDefault: boolean`.

---

## 8. Improvement Points — Implementations

**`glueGroupIds` — build a Map once**

(`src/routes/[projectId]/lib/project-page.ts:43-47`)

```ts
// Current: O(n) find + O(n) filter per call
// Better: pre-build Map<glueId, cardId[]> once and pass it in
const groupByGlue = new Map<string, string[]>();
for (const rel of glueRels) {
  if (!groupByGlue.has(rel.glueId)) groupByGlue.set(rel.glueId, []);
  groupByGlue.get(rel.glueId)!.push(rel.cardId);
}
```

Both `applyRectangleSelection` and the drag/click handlers call this in loops.

**`previousPositions` and `cardPositionPatches` share a map build**

Both construct `new Map(cards.map(card => [card.id, card]))` over the same array. In `KozaneCanvas.svelte` both are called at drag start — merge into one utility that returns both structures.

**`updateCard` manual field accumulation**

(`src/db/api/card.ts:119-133`)

The `if (x !== undefined) fields.x = x` pattern for each optional field is verbose. Drizzle's `.set()` with `undefined` values may be equivalent (check current Drizzle version behavior), which would simplify the function.

**`withTx` casts through `any`**

(`src/db/tx.ts:12`)

```ts
return db.transaction(fn as any);
```

This is a known upstream type limitation in `drizzle-orm/libsql`. A comment explaining the reason prevents future readers from attempting to remove it.

**`applyPalette` silent color wrapping**

(`src/routes/[projectId]/lib/project-page.ts:27-29`)

Colors repeat silently when bundles exceed 8. A comment noting this is intentional prevents confusion.

---

## 9. Learning Paths

### Goal 1: Card creation from a working copy

1. [`src/cli/index.ts`](../src/cli/index.ts) — CLI entry; understand `kozane open`
2. [`src/hooks.server.ts`](../src/hooks.server.ts) — DB injection into request context
3. [`src/db/schema.ts`](../src/db/schema.ts) — Understand `cardTable`, `workingCopyTable`, `scopeRelTable` and their FK relationships
4. [`src/db/api/composite.ts`](../src/db/api/composite.ts) — `createCardFromWorkingCopy` → `createCardInWorkingCopyContext`
5. [`src/db/api/scope-rel.ts`](../src/db/api/scope-rel.ts) — `addScopeRel` (idempotent insert)

### Goal 2: Glue/unglue lifecycle

1. [`src/db/api/glue.ts`](../src/db/api/glue.ts) — `glueCards` → `glueCardsCore` → `dissolveOrphanGroups`
2. [`src/db/tx.ts`](../src/db/tx.ts) — `DB` / `Tx` / `AnyDB` brand types
3. [`src/routes/[projectId]/api/glues/+server.ts`](../src/routes/%5BprojectId%5D/api/glues/+server.ts) — HTTP handler
4. [`src/routes/[projectId]/project-actions.svelte.ts`](../src/routes/%5BprojectId%5D/project-actions.svelte.ts) — `handleGlueSelected` / `handleUnglueSelected`
5. [`src/routes/[projectId]/lib/project-page.ts`](../src/routes/%5BprojectId%5D/lib/project-page.ts) — `glueGroupIds` / `dragGroupIds` (frontend group tracking)

### Goal 3: Canvas drag, pan, and selection

1. [`src/lib/constants.ts`](../src/lib/constants.ts) — `CANVAS_W/H`, `clamp`
2. [`src/routes/[projectId]/lib/project-page.ts`](../src/routes/%5BprojectId%5D/lib/project-page.ts) — Coordinate math (`clientToWorld`, `worldRectToScreenRect`, `rectsIntersect`)
3. [`src/routes/[projectId]/components/KozaneCanvas.svelte`](../src/routes/%5BprojectId%5D/components/KozaneCanvas.svelte) — Three state machines: `dragState`, `panState`, `rectangleSelectionState`

---

## Summary

The codebase is well-structured and type-safe with a clear domain model. The main concerns are:

- The N×1 API call pattern for bulk bundle reassignment (correctness risk on partial failure)
- Repeated project-ownership JOIN logic across the DB layer
- Type inconsistencies: `NeedsWorkingCopy` unused, `BundleWithColor.isDefault` incorrectly optional, `CardData` mixing stored and derived fields

The strongest design choices are the branded `DB`/`Tx`/`AnyDB` transaction types and the idempotent `addScopeRel` insertion. The `composite.ts` pattern for multi-step atomic operations is also a clear, maintainable approach.
