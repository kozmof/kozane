export const WC_MARKER_FILE = ".working-copy.json";
export const WC_MARKER_KIND = "kozane.workingCopy";
export const WC_MARKER_VERSION = 1;

export type WcMarker = {
  kind: typeof WC_MARKER_KIND;
  version: typeof WC_MARKER_VERSION;
  workingCopyId: string;
  projectId: string;
};
