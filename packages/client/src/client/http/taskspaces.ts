import type { KozaneClient } from "../contract.js";
import type { HttpResourceContext } from "./context.js";
import {
  readTaskspaceCreated,
  readTaskspaceRenamed,
  readTaskspaceRemoved,
  readTaskspaceFile,
  readTaskspaceEntryResult,
  readTaskspaceListing,
} from "../decoders/taskspaces.js";
import { ClientError } from "../contract.js";

export function createTaskspaces(
  context: HttpResourceContext,
): NonNullable<KozaneClient["taskspaces"]> {
  return {
    access: (_namespaceId, taskspace) => {
      const browse =
        !context.disposed() && context.capabilities().taskspaces && taskspace.path !== null;
      const write = browse && context.capabilities().writable;
      return {
        browse,
        read: write,
        write,
        refresh: write && context.capabilities().externalWrites,
      };
    },
    readFile: (ns, id, path, options) =>
      context.readTaskspace(
        context.ns(
          ns,
          `/taskspaces/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
        ),
        readTaskspaceFile,
        options,
      ),
    saveFile: (ns, id, input, options) =>
      context.writeTaskspace(
        context.ns(ns, `/taskspaces/${encodeURIComponent(id)}/file`),
        "PUT",
        input,
        readTaskspaceFile,
        options,
      ),
    list: (ns, id, path, options) =>
      context.readTaskspace(
        context.ns(
          ns,
          `/taskspaces/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`,
        ),
        readTaskspaceListing,
        options,
      ),
    createDirectory: (ns, id, input) =>
      context.writeTaskspace(
        context.ns(ns, `/taskspaces/${encodeURIComponent(id)}/files`),
        "POST",
        input,
        readTaskspaceListing,
      ),
    renameEntry: (ns, id, input) =>
      context.writeTaskspace(
        context.ns(ns, `/taskspaces/${encodeURIComponent(id)}/files`),
        "PATCH",
        input,
        readTaskspaceEntryResult,
      ),
    removeEntry: (ns, id, path) =>
      context.writeTaskspace(
        context.ns(
          ns,
          `/taskspaces/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`,
        ),
        "DELETE",
        undefined,
        readTaskspaceEntryResult,
      ),
    create: (ns, input) =>
      context.writeTaskspace(context.ns(ns, "/taskspaces"), "POST", input, readTaskspaceCreated),
    rename: async (ns, id, input) => {
      const result = await context.writeTaskspace(
        context.ns(ns, `/taskspaces/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        readTaskspaceRenamed,
      );
      if (result.id !== id) throw new ClientError("unavailable", "Invalid taskspace response");
      return result;
    },
    remove: (ns, id) =>
      context.writeTaskspace(
        context.ns(ns, `/taskspaces/${encodeURIComponent(id)}`),
        "DELETE",
        undefined,
        readTaskspaceRemoved,
      ),
    createFile: (ns, id, input) =>
      context.writeTaskspace(
        context.ns(ns, `/taskspaces/${encodeURIComponent(id)}/file`),
        "POST",
        input,
        readTaskspaceFile,
      ),
  };
}
