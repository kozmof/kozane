import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AnyDB } from "../../db/client.js";
import { getAllProjects } from "../../db/api/project.js";
import { getAllBundles, getBundleCardCounts, type BundleCardCount } from "../../db/api/bundle.js";
import { getCardChangeCounts, type CardChangeCount } from "../../db/api/card.js";
import {
  getAllScopes,
  getScopeBundleUsage,
  getScopeProjectUsage,
  type ScopeBundleUsage,
  type ScopeProjectUsage,
} from "../../db/api/scope.js";
import { getCardTagHits, type CardTagHits } from "../../db/api/tag.js";
import type { Project, Scope } from "../../db/api/types.js";
import { TREEMAP_CACHE_BYTES_MAX } from "../constants.js";
import { applyPalette } from "../../routes/[projectId]/lib/project-page.js";
import { writeFileAtomic } from "./atomic-write.js";
import { databaseSignature } from "./tag-cache.js";

export const TREEMAP_CACHE_VERSION = 1;
export const TREEMAP_CACHE_FILE = "treemap.json";

export type TreemapBundle = BundleCardCount & { bg: string; dot: string };

/** The workspace facts needed to derive every map view. Geometry and query selections are
 * deliberately absent: they are cheap browser-side projections of these facts. */
export type TreemapSnapshot = {
  projects: Project[];
  bundles: TreemapBundle[];
  activity: CardChangeCount[];
  scopes: Scope[];
  bundleUsage: ScopeBundleUsage[];
  projectUsage: ScopeProjectUsage[];
  tags: CardTagHits;
};

type TreemapCache = {
  version: number;
  db: string;
  builtAt: string;
  includeScopes: boolean;
  snapshot: TreemapSnapshot;
};

export const treemapCachePath = (root: string): string => join(root, ".kozane", TREEMAP_CACHE_FILE);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown, fields: string[]): boolean =>
  isRecord(value) && fields.every((field) => typeof value[field] === "string");
const arrayOf = (value: unknown, check: (entry: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every(check);

const isProject = (value: unknown): boolean =>
  strings(value, ["id", "name"]) &&
  typeof (value as Record<string, unknown>).isDefault === "boolean";
const isBundle = (value: unknown): boolean =>
  strings(value, ["id", "projectId", "name", "bg", "dot"]) &&
  typeof (value as Record<string, unknown>).isDefault === "boolean" &&
  typeof (value as Record<string, unknown>).cards === "number";
const isActivity = (value: unknown): boolean =>
  strings(value, ["day", "bundleId"]) &&
  typeof (value as Record<string, unknown>).cards === "number";
const isScope = (value: unknown): boolean => strings(value, ["id", "name"]);
const isBundleUsage = (value: unknown): boolean =>
  strings(value, ["scopeId", "bundleId"]) &&
  typeof (value as Record<string, unknown>).cards === "number";
const isProjectUsage = (value: unknown): boolean => strings(value, ["scopeId", "projectId"]);
const isTagHit = (value: unknown): boolean => {
  if (!strings(value, ["tag", "excerpt"])) return false;
  const source = (value as Record<string, unknown>).source;
  return isRecord(source) && source.kind === "card" && typeof source.cardId === "string";
};
const isTags = (value: unknown): boolean => {
  if (!isRecord(value) || !arrayOf(value.hits, isTagHit) || typeof value.truncated !== "boolean")
    return false;
  if (
    !isRecord(value.cardProjects) ||
    !Object.values(value.cardProjects).every((v) => typeof v === "string")
  )
    return false;
  return (
    isRecord(value.cardData) &&
    Object.values(value.cardData).every((card) =>
      strings(card, ["projectId", "bundleId", "updatedDay"]),
    )
  );
};

function isTreemapCache(value: unknown): value is TreemapCache {
  if (
    !isRecord(value) ||
    value.version !== TREEMAP_CACHE_VERSION ||
    typeof value.db !== "string" ||
    typeof value.builtAt !== "string" ||
    typeof value.includeScopes !== "boolean" ||
    !isRecord(value.snapshot)
  )
    return false;
  const snapshot = value.snapshot;
  return (
    arrayOf(snapshot.projects, isProject) &&
    arrayOf(snapshot.bundles, isBundle) &&
    arrayOf(snapshot.activity, isActivity) &&
    arrayOf(snapshot.scopes, isScope) &&
    arrayOf(snapshot.bundleUsage, isBundleUsage) &&
    arrayOf(snapshot.projectUsage, isProjectUsage) &&
    isTags(snapshot.tags)
  );
}

export function readTreemapCache(root: string): TreemapCache | null {
  try {
    const path = treemapCachePath(root);
    if (statSync(path).size > TREEMAP_CACHE_BYTES_MAX) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isTreemapCache(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeTreemapCache(root: string, value: TreemapCache): void {
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > TREEMAP_CACHE_BYTES_MAX) return;
    writeFileAtomic(treemapCachePath(root), serialized);
  } catch {
    // A cache must never turn a readable map into an error.
  }
}

async function paletteByBundle(
  db: AnyDB,
  projectIds: string[],
): Promise<Record<string, { bg: string; dot: string }>> {
  const palettes = await Promise.all(
    projectIds.map(async (projectId) => applyPalette(await getAllBundles({ db, projectId }))),
  );
  const colours: Record<string, { bg: string; dot: string }> = {};
  for (const bundles of palettes) for (const { id, bg, dot } of bundles) colours[id] = { bg, dot };
  return colours;
}

export async function loadTreemapSnapshot({
  db,
  includeScopes,
  cache,
}: {
  db: AnyDB;
  includeScopes: boolean;
  cache?: { root: string; dbUrl: string };
}): Promise<TreemapSnapshot> {
  const signature = cache ? databaseSignature(cache.dbUrl) : null;
  const stored = cache ? readTreemapCache(cache.root) : null;
  if (signature && stored?.db === signature && stored.includeScopes === includeScopes)
    return stored.snapshot;

  const [projects, counts, activity, tags, scopes, bundleUsage, projectUsage] = await Promise.all([
    getAllProjects({ db }),
    getBundleCardCounts({ db }),
    getCardChangeCounts({ db }),
    getCardTagHits({ db }),
    includeScopes ? getAllScopes({ db }) : Promise.resolve([]),
    includeScopes ? getScopeBundleUsage({ db }) : Promise.resolve([]),
    includeScopes ? getScopeProjectUsage({ db }) : Promise.resolve([]),
  ]);
  const colours = await paletteByBundle(
    db,
    projects.map(({ id }) => id),
  );
  const snapshot: TreemapSnapshot = {
    projects,
    bundles: counts.map((bundle) => ({
      ...bundle,
      ...(colours[bundle.id] ?? { bg: "transparent", dot: "currentColor" }),
    })),
    activity,
    scopes,
    bundleUsage,
    projectUsage,
    tags,
  };

  if (signature && cache)
    writeTreemapCache(cache.root, {
      version: TREEMAP_CACHE_VERSION,
      db: signature,
      builtAt: new Date().toISOString(),
      includeScopes,
      snapshot,
    });
  return snapshot;
}
