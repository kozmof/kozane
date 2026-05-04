export interface CardData {
  id: string;
  content: string;
  bundleId: string;
  posX: number;
  posY: number;
  glueId: string | null;
  workingCopyId: string | null;
}

export interface BundleWithColor {
  id: string;
  name: string;
  bg: string;
  dot: string;
}

export interface GlueRel {
  glueId: string;
  cardId: string;
}
