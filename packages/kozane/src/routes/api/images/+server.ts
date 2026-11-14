import { getWorkspaceRoot } from "../../../db/internal/config.js";
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { error, json } from '@sveltejs/kit';
export async function POST({ request }) {
  const form = await request.formData();
  const file = form.get('image');
  if (!(file instanceof File)) error(400, 'Choose an image');
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!extension || !['jpg', 'jpeg', 'png', 'svg'].includes(extension)) error(400, 'Choose JPEG, PNG, or SVG');
  if (file.size === 0 || file.size > 10 * 1024 * 1024) error(400, 'Image must be between 1 byte and 10 MB');
  const root = getWorkspaceRoot();
  if (!root) error(500, 'Workspace not found');
  const directory = resolve(root, '.kozane/assets/images');
  await mkdir(directory, { recursive: true });
  const name = randomUUID() + '.' + extension;
  await writeFile(resolve(directory, name), Buffer.from(await file.arrayBuffer()), { flag: 'wx' });
  return json({ url: '/api/images/' + name });
}
