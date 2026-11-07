import { records } from "@kozane/core/database";
export const getGlueRelsByCards: typeof records.glue.getGlueRelsByCards =
  records.glue.getGlueRelsByCards;
export const getGlueRelsByNamespace: typeof records.glue.getGlueRelsByNamespace =
  records.glue.getGlueRelsByNamespace;
export const dissolveOrphanGlueGroupsInTx: typeof records.glue.dissolveOrphanGlueGroupsInTx =
  records.glue.dissolveOrphanGlueGroupsInTx;
export const glueCards: typeof records.glue.glueCards = records.glue.glueCards;
export const unglueCards: typeof records.glue.unglueCards = records.glue.unglueCards;
export const unglueCardsInTx: typeof records.glue.unglueCardsInTx = records.glue.unglueCardsInTx;
export const glueNamespaceCards: typeof records.glue.glueNamespaceCards =
  records.glue.glueNamespaceCards;
export const glueNamespaceCardsInTx: typeof records.glue.glueNamespaceCardsInTx =
  records.glue.glueNamespaceCardsInTx;
export const unglueNamespaceCards: typeof records.glue.unglueNamespaceCards =
  records.glue.unglueNamespaceCards;
export const unglueNamespaceCardsInTx: typeof records.glue.unglueNamespaceCardsInTx =
  records.glue.unglueNamespaceCardsInTx;
export type GlueResult = records.glue.GlueResult;
export type UnglueResult = records.glue.UnglueResult;
