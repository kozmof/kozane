import type { AnyDB } from "../db/database.js";
import type { ServiceContext } from "./context.js";
import { getCardTagHits } from "../db/api/tag.js";
export function get(db: AnyDB, _context: ServiceContext, namespaceId?: string) {
  return getCardTagHits({ db, namespaceId });
}
