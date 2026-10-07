export const TASKSPACE_MARKER_FILE = ".taskspace.json";
export const TASKSPACE_MARKER_KIND = "kozane.taskspace";
/**
 * Version 2 replaces `projectId` with `namespaceId`. Reject version 1 markers rather than
 * reattaching them without a namespace. Use {@link TASKSPACE_MARKER_VERSION_1} for upgrade
 * guidance.
 */
export const TASKSPACE_MARKER_VERSION = 2;
/** The version this file carried before the rename, recognised only to say so. */
export const TASKSPACE_MARKER_VERSION_1 = 1;

export type TaskspaceMarker = {
  kind: typeof TASKSPACE_MARKER_KIND;
  version: typeof TASKSPACE_MARKER_VERSION;
  taskspaceId: string;
  namespaceId: string;
};
