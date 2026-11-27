import { expect, expectTypeOf, it } from "vitest";
import { actionContractsV1, type ActionInputsV1 } from "../../../core/src/actions/contracts.js";
import { operationKinds } from "../../../client/src/client/operation-kinds.js";

it("declares every classified client write and excludes classified reads", () => {
  for (const [resource, methods] of Object.entries(operationKinds)) {
    for (const [method, classification] of Object.entries(methods)) {
      const kind = `${resource}.${method}`;
      expect(Object.hasOwn(actionContractsV1, kind)).toBe(classification === "write");
    }
  }
});

it("keeps filesystem and unsplit taskspace lifecycle work local-only", () => {
  for (const [kind, eligibility] of Object.entries(actionContractsV1)) {
    expect(eligibility).toBe(kind.startsWith("taskspaces.") ? "local-only" : "syncable");
  }
});

it("requires full routing and target arguments in typed invocation envelopes", () => {
  expectTypeOf<ActionInputsV1["cards.update"]["args"]>().toEqualTypeOf<
    { namespaceId: string } & Record<"cardId", string>
  >();
  expectTypeOf<ActionInputsV1["scopes.updateArea"]["args"]>().toEqualTypeOf<
    { namespaceId: string } & Record<"scopeId" | "areaId", string>
  >();
  expectTypeOf<ActionInputsV1["taskspaces.removeEntry"]["args"]>().toMatchTypeOf<{
    namespaceId: string;
    taskspaceId: string;
    path: string;
  }>();
});
