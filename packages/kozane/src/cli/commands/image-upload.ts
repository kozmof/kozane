import {
  abandonImageUpload,
  listImageUploads,
  recoverImageUpload,
} from "../../lib/server/image-upload-recovery.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

export async function imageUploads(options: { all?: boolean } = {}) {
  await runWorkspaceCommand(async ({ db }) => {
    const rows = await listImageUploads(db, options.all === true);
    if (!rows.length)
      console.log(options.all ? "No image upload records." : "No unfinished image uploads.");
    for (const row of rows)
      console.log(`${row.filename}  ${row.state}${row.error ? `  ${row.error}` : ""}`);
  });
}

export async function imageRecover(filename: string, options: { apply?: boolean } = {}) {
  await runWorkspaceCommand(async ({ db, root }) => {
    const result = await recoverImageUpload(db, root, filename, options.apply === true);
    console.log(`  filename  : ${result.upload.filename}`);
    console.log(`  state     : ${result.upload.state}`);
    console.log(`  bytes     : ${result.upload.byteLength}`);
    console.log(`  sha256    : ${result.upload.sha256}`);
    console.log(`  card link : ${result.linked ? "present" : "absent"}`);
    if (result.evidence) {
      console.log(`  published : ${result.evidence.published}`);
      console.log(`  temporary : ${result.evidence.temporary}`);
    }
    if (result.upload.error) console.log(`  error     : ${result.upload.error}`);
    if (result.status === "blocked")
      throw new Error(`Image upload cannot be recovered: ${result.reason}`);
    if (result.status === "already-completed")
      console.log("Image upload was already completed. No changes made.");
    else {
      console.log(`  url       : /api/images/${result.upload.filename}`);
      if (result.status === "confirmable")
        console.log("Read-only preview. Rerun with --apply to confirm verified database changes.");
      else if (result.upload.state === "completed")
        console.log("Image upload completed against an existing card reference. No files changed.");
      else
        console.log(
          "Installation verified. Its pin remains until a card references the image or reviewed tracking is abandoned. No files changed.",
        );
    }
  });
}

export async function imageAbandon(filename: string, options: { reason: string; apply?: boolean }) {
  await runWorkspaceCommand(async ({ db }) => {
    const result = await abandonImageUpload(db, filename, options.reason, options.apply === true);
    console.log(`  filename  : ${result.upload.filename}`);
    console.log(`  state     : ${result.upload.state}`);
    console.log(`  sha256    : ${result.upload.sha256}`);
    console.log(`  reason    : ${result.upload.abandonReason ?? options.reason.trim()}`);
    console.log(`  card link : ${result.linked ? "present" : "absent"}`);
    if (result.upload.error) console.log(`  error     : ${result.upload.error}`);
    if (result.changed)
      console.log(
        "Upload pin released. Evidence retained. No files changed; live card references still protect their bytes.",
      );
    else if (result.upload.state === "abandoned")
      console.log("Image upload was already abandoned. No changes made.");
    else
      console.log(
        "Read-only preview. Review disk state, then rerun with --apply to release only this upload pin. Files remain subject to normal cleanup.",
      );
  });
}
