export const TASKSPACE_MARKER_FILE = ".taskspace.json";
export const TASKSPACE_MARKER_KIND = "kozane.taskspace";
export const TASKSPACE_MARKER_VERSION = 1;

export type TaskspaceMarker = {
  kind: typeof TASKSPACE_MARKER_KIND;
  version: typeof TASKSPACE_MARKER_VERSION;
  taskspaceId: string;
  projectId: string;
};
