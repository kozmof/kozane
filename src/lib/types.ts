export interface CardData {
  id: string;
  content: string;
  bundleId: string;
  posX: number;
  posY: number;
  glueId: string | null;
  workingCopyId: string | null;
}

export interface Bundle {
  id: string;
  projectId: string;
  name: string;
  isDefault: boolean;
}

export interface BundleWithColor {
  id: string;
  name: string;
  bg: string;
  dot: string;
  isDefault?: boolean;
}

export interface Scope {
  id: string;
  name: string;
}

export interface ScopeRel {
  scopeId: string;
  cardId: string;
}

export interface GlueRel {
  glueId: string;
  cardId: string;
}

export interface WorkingCopy {
  id: string;
  name: string;
  scopeId: string | null;
  path: string | null;
}
