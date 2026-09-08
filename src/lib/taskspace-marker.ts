export const TASKSPACE_MARKER_FILE = ".taskspace.json";
export const TASKSPACE_MARKER_KIND = "kozane.taskspace";
/**
 * Version 2 renamed this file's `projectId` field to `namespaceId`.
 *
 * A version 1 marker is refused rather than read: the two differ by the one field a
 * reattach exists to use, so reading one as version 2 would silently attach the taskspace
 * to no namespace at all. Every `.taskspace.json` written before this release is therefore
 * stale, and `kozane taskspace scan --apply --reattach` will not pick those directories up
 * — see {@link TASKSPACE_MARKER_VERSION_1} for the message they get instead.
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
