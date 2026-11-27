/** Run real image operations in a process the test can kill at an acknowledged boundary. */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { brandDb } from "../db/tx.js";
import * as schema from "../db/schema.js";
import { classifyLibsqlFailure } from "../db/internal/classify-failure.js";

const [root, operation, stop = ""] = process.argv.slice(2);
const images = join(root, ".kozane", "assets", "images");
const archive = join(images, ".retained");
const queue = join(images, ".pending-delete");
let removed = false;
let requestRemoved = false;
async function boundary(name: string) {
  if (name !== stop) return;
  // Root the pending promise through IPC. An unreachable pause can be collected along
  // with the transaction and its native connection, releasing the very lock under test.
  await new Promise<void>((resume) => {
    process.on("message", (message) => {
      if (message === "resume") resume();
    });
    setImmediate(() => {
      global.gc!();
      process.send!({ boundary: name });
    });
  });
}

const original = {
  mkdir: fs.promises.mkdir,
  open: fs.promises.open,
  link: fs.promises.link,
  unlink: fs.promises.unlink,
  rm: fs.promises.rm,
};
Object.assign(fs.promises, {
  mkdir: async (...args: Parameters<typeof original.mkdir>) => {
    if (String(args[0]) === join(root, ".kozane")) await boundary("reservation-committed");
    return original.mkdir(...args);
  },
  open: async (...args: Parameters<typeof original.open>) => {
    const path = String(args[0]);
    if (basename(path).startsWith(".upload-")) await boundary("before-file");
    const handle = await original.open(...args);
    if (basename(path).startsWith(".upload-")) await boundary("temporary-created");
    const writeFile = handle.writeFile.bind(handle);
    handle.writeFile = async (...writeArgs) => {
      await writeFile(...writeArgs);
      if (basename(path).startsWith(".upload-")) await boundary("temporary-written");
    };
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      await sync();
      if (basename(path).startsWith(".upload-")) await boundary("temporary-synced");
      if (path === images && (operation !== "delete" || removed)) await boundary("images-synced");
      if (path === archive) await boundary("archive-synced");
      if (path === queue)
        await boundary(requestRemoved ? "request-ack-synced" : "request-directory-synced");
      if (path.startsWith(queue + "/") || path.startsWith(queue + "\\"))
        await boundary("request-file-synced");
      if (operation === "archive" && path.startsWith(images) && path !== archive && path !== images)
        await boundary("archive-file-synced");
    };
    return handle;
  },
  link: async (...args: Parameters<typeof original.link>) => {
    await original.link(...args);
    await boundary("linked");
  },
  unlink: async (...args: Parameters<typeof original.unlink>) => {
    await original.unlink(...args);
    await boundary(
      basename(String(args[0])).startsWith(".upload-") ? "temporary-unlinked" : "live-unlinked",
    );
  },
  rm: async (...args: Parameters<typeof original.rm>) => {
    const path = String(args[0]);
    if (operation === "delete" && path.startsWith(images) && !path.startsWith(queue))
      await boundary("delete-committed");
    await original.rm(...args);
    removed = true;
    if (path.startsWith(queue + "/") || path.startsWith(queue + "\\")) {
      requestRemoved = true;
      await boundary("request-removed");
    } else if (path.startsWith(archive + "/") || path.startsWith(archive + "\\"))
      await boundary("archive-removed");
    else await boundary("live-removed");
  },
});
// Update both named and namespace imports before loading the application modules.
syncBuiltinESMExports();

const { storeImage, collectUnusedImages, retryImageDeletions, withImageDeletion } =
  await import("../lib/server/image-assets.js");
const { recoverImageUpload } = await import("../lib/server/image-upload-recovery.js");
const cards = await import("../services/cards.js");
const { createServiceContext } = await import("../services/context.js");
const { withTx } = await import("../db/database.js");
const client = createClient({ url: `file:${join(root, "db.sqlite")}` });
const db = brandDb(drizzle(client, { schema }));
try {
  if (operation === "upload") {
    await storeImage(
      root,
      db,
      "image.svg",
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    );
    await boundary("installed-committed");
  } else if (operation === "card") {
    const [namespace] = await db.select().from(schema.namespaceTable);
    const [partition] = await db.select().from(schema.partitionTable);
    const [upload] = await db.select().from(schema.localImageUploadTable);
    await withTx(db, async (tx) => {
      await cards.createInTx(tx, createServiceContext(), namespace.id, {
        partitionId: partition.id,
        content: "kozane-image:/api/images/" + upload.filename,
      });
      await boundary("card-before-commit");
    });
    await boundary("card-committed");
  } else if (operation === "delete") {
    const [namespace] = await db.select().from(schema.namespaceTable);
    const [card] = await db.select().from(schema.cardTable);
    await withImageDeletion(root, db, async (tx, capture) => {
      await capture({ namespaceId: namespace.id, cardIds: [card.id] });
      await tx.delete(schema.cardTable).where(eq(schema.cardTable.id, card.id));
    });
    await boundary("deletion-complete");
  } else if (operation === "archive") {
    await collectUnusedImages(root, db, Date.now() + 3 * 86400000);
    await boundary("archive-complete");
  } else if (operation === "maintenance") {
    await retryImageDeletions(root, db);
    await collectUnusedImages(root, db, Date.now() + 3 * 86400000);
  } else if (operation === "contending-cleanup") {
    await client.execute("PRAGMA busy_timeout=1");
    for (const cleanup of [retryImageDeletions, collectUnusedImages]) {
      let refused = false;
      try {
        await cleanup(root, db, Date.now() + 3 * 86400000);
      } catch (error) {
        if (classifyLibsqlFailure(error).kind !== "transient") throw error;
        refused = true;
      }
      if (!refused)
        throw new Error(`${cleanup.name} did not respect the other process's writer lock`);
    }
  } else if (operation === "recover") {
    const [upload] = await db.select().from(schema.localImageUploadTable);
    await recoverImageUpload(db, root, upload.filename, true);
  } else throw new Error(`Unknown image crash operation ${operation}`);
  if (stop) throw new Error(`Image operation never reached ${stop}`);
} finally {
  client.close();
}
process.send!({ complete: true });
process.disconnect!();
