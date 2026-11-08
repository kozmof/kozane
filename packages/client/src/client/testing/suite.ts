import { assertTaskspaceSupport } from "../capabilities.js";
import {
  ClientError,
  type ClientInvalidation,
  type ClientState,
  type KozaneClient,
  type ClientDataset,
} from "../contract.js";
import { readNamespaceSnapshot } from "../decoders/snapshot-reader.js";
import { readTagsViewData } from "../decoders/tags.js";
import { readMapSnapshot } from "../decoders/map.js";
import { parseWarpEntries } from "../decoders/warp-directory.js";
import { clientMutationCases } from "./mutations.js";
export interface ClientContractFixture {
  client: KozaneClient;
  namespaceId: string;
  missingNamespaceId?: string;
  unavailableDatasets?: readonly Extract<ClientDataset, "tags" | "map" | "warpDirectory">[];
  cleanup?(): void | Promise<void>;
}
export type ClientContractFactory = () => ClientContractFixture | Promise<ClientContractFixture>;
export interface ClientContractOptions {
  mode?: "read-only" | "writable";
  initialContent?: string;
  updatedContent?: string;
}
export interface ClientContractCase {
  readonly name: string;
  run(): Promise<void>;
}
export class ClientContractFailure extends Error {
  override readonly name = "ClientContractFailure";
  constructor(
    readonly caseName: string,
    cause: unknown,
  ) {
    super(
      `Client contract failed (${caseName}): ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function rejection(operation: () => Promise<unknown>, code: string) {
  let rejected = false;
  try {
    await operation();
  } catch (error) {
    rejected = true;
    check(
      error instanceof ClientError && error.code === code,
      `Expected ClientError(${code}); received ${error instanceof Error ? error.name + ": " + error.message : String(error)}`,
    );
  }
  check(rejected, `Expected ${code} rejection`);
}
async function readOnly(fixture: ClientContractFixture, operation: () => Promise<void>) {
  const before = { ...fixture.client.version };
  const events: ClientInvalidation[] = [];
  const release = fixture.client.subscribe((event) => events.push(event));
  try {
    await operation();
    check(events.length === 0, "Reads/rejections must not publish invalidations");
    check(
      fixture.client.version.generation === before.generation &&
        fixture.client.version.revision === before.revision,
      "Reads/rejections must not change the data version",
    );
  } finally {
    release();
  }
}
/** Register each returned case with any test runner. Every run owns a fresh fixture. */
export function clientContractCases(
  create: ClientContractFactory,
  options: ClientContractOptions = {},
): readonly ClientContractCase[] {
  check(
    options.mode === undefined || options.mode === "read-only" || options.mode === "writable",
    "Unknown client contract mode",
  );
  const writable = options.mode === "writable";
  const cases: ClientContractCase[] = [];
  const add = (name: string, operation: (fixture: ClientContractFixture) => Promise<void>) => {
    cases.push(
      Object.freeze({
        name,
        async run() {
          let fixture: ClientContractFixture;
          try {
            fixture = await create();
          } catch (error) {
            throw new ClientContractFailure(name, error);
          }
          let failure: unknown;
          let failed = false;
          try {
            check(
              fixture.client.capabilities.writable === writable,
              "Fixture writable capability must match the suite mode",
            );
            check(
              fixture.client.state.status === "ready",
              "Fixture must be ready before a case starts",
            );
            assertTaskspaceSupport(fixture.client);
            await operation(fixture);
          } catch (error) {
            failed = true;
            failure = error;
          }
          try {
            await fixture.cleanup?.();
          } catch (error) {
            failure = failed
              ? new AggregateError([failure, error], "Case and fixture cleanup failed")
              : error;
            failed = true;
          }
          if (failed) throw new ClientContractFailure(name, failure);
        },
      }),
    );
  };
  add("state subscriptions are immediate", async ({ client }) => {
    const states: ClientState[] = [];
    const release = client.subscribeState((state) => states.push(state));
    try {
      check(
        states.length === 1 && states[0].status === "ready",
        "subscribeState must immediately publish current readiness",
      );
    } finally {
      release();
    }
  });
  add("namespace reads agree", async (fixture) =>
    readOnly(fixture, async () => {
      const rows = await fixture.client.namespaces.list();
      check(
        rows.some((row) => row.id === fixture.namespaceId),
        "Fixture namespace is missing from list",
      );
      check(
        new Set(rows.map((row) => row.id)).size === rows.length,
        "Namespace list contains duplicates",
      );
      const row = await fixture.client.namespaces.get(fixture.namespaceId);
      check(
        row.id === fixture.namespaceId &&
          typeof row.name === "string" &&
          typeof row.isDefault === "boolean",
        "Namespace get returned invalid metadata",
      );
    }),
  );
  add("snapshot validators are stable", async (fixture) =>
    readOnly(fixture, async () => {
      const first = await fixture.client.snapshot(fixture.namespaceId);
      check(
        first.status === "changed" && first.validator.length > 0,
        "Unconditional snapshot must contain data and a validator",
      );
      check(
        readNamespaceSnapshot(first.data)?.namespace.id === fixture.namespaceId,
        "Snapshot has invalid data or a different namespace",
      );
      const next = await fixture.client.snapshot(fixture.namespaceId, {
        validator: first.validator,
      });
      check(
        next.status === "unchanged" && next.validator === first.validator,
        "An unchanged snapshot must retain its validator",
      );
    }),
  );
  add("missing namespace snapshots reject", async (fixture) =>
    readOnly(fixture, () =>
      rejection(
        () =>
          fixture.client.snapshot(
            fixture.missingNamespaceId ?? "00000000-0000-4000-8000-000000000000",
          ),
        "not_found",
      ),
    ),
  );
  for (const dataset of ["tags", "map", "warpDirectory"] as const) {
    add(`${dataset} reads obey availability`, async (fixture) =>
      readOnly(fixture, async () => {
        const get = () =>
          dataset === "tags"
            ? fixture.client.tags.get()
            : dataset === "map"
              ? fixture.client.map.get()
              : fixture.client.warpDirectory.get(fixture.namespaceId);
        if (fixture.unavailableDatasets?.includes(dataset)) return rejection(get, "unavailable");
        const result = await get();
        check(
          (dataset === "tags"
            ? readTagsViewData(result)
            : dataset === "map"
              ? readMapSnapshot(result)
              : parseWarpEntries(result)) !== null,
          `${dataset} returned invalid data`,
        );
      }),
    );
  }
  add("taskspace capability agrees with API availability", async ({ client }) => {
    assertTaskspaceSupport(client);
  });
  if (!writable) {
    for (const [name, mutation] of Object.entries(clientMutationCases))
      add(`read-only ${name}`, async (fixture) =>
        readOnly(fixture, () => rejection(() => mutation.call(fixture.client), "read_only")),
      );
  } else {
    add("namespace creation initializes defaults", async ({ client }) => {
      const ns = await client.namespaces.create({ name: "Contract workspace" });
      const snapshot = await client.snapshot(ns.id);
      check(snapshot.status === "changed", "Created namespace is unreadable");
      check(
        snapshot.data.partitions.length === 1 && snapshot.data.partitions[0].isDefault,
        "Namespace needs its default partition",
      );
      check(
        snapshot.data.layers.length === 1 && snapshot.data.layers[0].isDefault,
        "Namespace needs its default layer",
      );
      check(snapshot.data.cards.length === 0, "New namespace must have no cards");
    });
    add("card CRUD publishes committed versions", async ({ client }) => {
      const ns = await client.namespaces.create({ name: "Contract cards" });
      const seed = await client.snapshot(ns.id);
      check(seed.status === "changed", "Created namespace is unreadable");
      const events: ClientInvalidation[] = [];
      const before = client.version;
      const release = client.subscribe((event) => {
        check(
          client.version.generation === event.generation &&
            client.version.revision === event.revision,
          "Invalidation preceded its committed version",
        );
        events.push(event);
      });
      try {
        const card = await client.cards.create(ns.id, {
          partitionId: seed.data.partitions[0].id,
          content: options.initialContent ?? "Contract 日本語",
        });
        const created = await client.snapshot(ns.id);
        check(
          created.status === "changed" && created.data.cards.some((row) => row.id === card.id),
          "Created card is absent after commit",
        );
        await client.cards.update(ns.id, card.id, {
          content: options.updatedContent ?? "Updated 日本語",
          width: 200,
        });
        await client.cards.update(ns.id, card.id, { width: null });
        const updated = await client.snapshot(ns.id);
        check(
          updated.status === "changed" &&
            updated.data.cards.some(
              (row) =>
                row.id === card.id &&
                row.content === (options.updatedContent ?? "Updated 日本語") &&
                row.width === null,
            ),
          "Update/null reset is absent after commit",
        );
        await client.cards.removeOne(ns.id, card.id);
        const removed = await client.snapshot(ns.id);
        check(
          removed.status === "changed" && !removed.data.cards.some((row) => row.id === card.id),
          "Removed card remains in snapshot",
        );
        check(
          events.length >= 4 && client.version.revision > before.revision,
          "Committed writes need versioned invalidations",
        );
      } finally {
        release();
      }
    });
    add("invalid card creation leaves version unchanged", async (fixture) => {
      const ns = await fixture.client.namespaces.create({ name: "Contract rejection" });
      const snapshot = await fixture.client.snapshot(ns.id);
      check(snapshot.status === "changed", "Created namespace is unreadable");
      await readOnly(fixture, async () => {
        await rejection(
          () =>
            fixture.client.cards.create(ns.id, {
              partitionId: snapshot.data.partitions[0].id,
              content: "",
            }),
          "validation",
        );
        const after = await fixture.client.snapshot(ns.id);
        check(
          after.status === "changed" && after.data.cards.length === snapshot.data.cards.length,
          "Rejected creation changed stored cards",
        );
      });
    });
  }
  return Object.freeze(cases);
}
/** Execute serially, stopping at the first failed case after its fixture cleanup. */
export async function runClientContract(
  create: ClientContractFactory,
  options?: ClientContractOptions,
): Promise<readonly string[]> {
  const passed: string[] = [];
  for (const test of clientContractCases(create, options)) {
    await test.run();
    passed.push(test.name);
  }
  return Object.freeze(passed);
}
