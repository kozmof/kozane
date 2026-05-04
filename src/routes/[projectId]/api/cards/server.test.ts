import { describe, expect, it } from "vitest";
import { addBundle } from "../../../../db/api/bundle.js";
import { addCard, getCard } from "../../../../db/api/card.js";
import { addProject } from "../../../../db/api/project.js";
import type { DB } from "../../../../db/tx.js";
import { createTestDB } from "../../../../test-utils/db.js";
import { PATCH, POST } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/project-1/api/cards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function event(db: DB, projectId: string, request: Request) {
  return {
    locals: { db },
    params: { projectId },
    request,
  } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Project" });
  const bundleId = await addBundle({ db, projectId, name: "General", isDefault: true });
  return { db, projectId, bundleId };
}

describe("POST /[projectId]/api/cards", () => {
  it("creates a trimmed card in a project bundle", async () => {
    const { db, projectId, bundleId } = await setup();

    const response = await POST(
      event(db, projectId, jsonRequest({ bundleId, content: "  New card  ", posX: 24, posY: 48 })),
    );

    expect(response.status).toBe(200);
    const { id } = await response.json();
    await expect(getCard({ db, bundleId, cardId: id })).resolves.toMatchObject({
      content: "New card",
      posX: 24,
      posY: 48,
    });
  });

  it("rejects blank card content", async () => {
    const { db, projectId, bundleId } = await setup();

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ bundleId, content: "   " }))),
      400,
      "content is required",
    );
  });

  it("rejects bundles outside the project", async () => {
    const { db, projectId } = await setup();
    const otherProjectId = await addProject({ db, name: "Other" });
    const otherBundleId = await addBundle({ db, projectId: otherProjectId, name: "Other" });

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ bundleId: otherBundleId, content: "Nope" }))),
      400,
      "Bundle not found in project",
    );
  });
});

describe("PATCH /[projectId]/api/cards", () => {
  it("updates card positions for cards in the project", async () => {
    const { db, projectId, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Move me", posX: 0, posY: 0 });

    const response = await PATCH(
      event(db, projectId, jsonRequest({ positions: [{ cardId, posX: 72, posY: 96 }] })),
    );

    expect(response.status).toBe(200);
    await expect(getCard({ db, bundleId, cardId })).resolves.toMatchObject({
      posX: 72,
      posY: 96,
    });
  });

  it("rejects duplicate card ids before updating", async () => {
    const { db, projectId, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Still", posX: 0, posY: 0 });

    await expectHttpRejection(
      PATCH(
        event(
          db,
          projectId,
          jsonRequest({
            positions: [
              { cardId, posX: 24, posY: 24 },
              { cardId, posX: 48, posY: 48 },
            ],
          }),
        ),
      ),
      400,
      "cardId must be unique",
    );

    await expect(getCard({ db, bundleId, cardId })).resolves.toMatchObject({ posX: 0, posY: 0 });
  });

  it("rejects cards outside the project without updating local cards", async () => {
    const { db, projectId, bundleId } = await setup();
    const localCardId = await addCard({ db, bundleId, content: "Local", posX: 0, posY: 0 });
    const otherProjectId = await addProject({ db, name: "Other" });
    const otherBundleId = await addBundle({ db, projectId: otherProjectId, name: "Other" });
    const otherCardId = await addCard({ db, bundleId: otherBundleId, content: "Other" });

    await expectHttpRejection(
      PATCH(
        event(
          db,
          projectId,
          jsonRequest({
            positions: [
              { cardId: localCardId, posX: 24, posY: 24 },
              { cardId: otherCardId, posX: 48, posY: 48 },
            ],
          }),
        ),
      ),
      400,
      "Some cards do not belong to this project",
    );

    await expect(getCard({ db, bundleId, cardId: localCardId })).resolves.toMatchObject({
      posX: 0,
      posY: 0,
    });
  });
});
