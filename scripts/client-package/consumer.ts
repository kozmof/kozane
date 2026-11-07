import { createViewFixture } from "./view-fixture.js";
import { backendContractCases, type BackendContractFactory } from "@kozane/client/testing";
import {
  EditorDocument,
  EditorSurface,
  FileEditor,
  NamespacesView,
  BoardView,
  TagsView,
  MapView,
  DEFAULT_UI_CONFIG as uiDefaults,
} from "@kozane/client/ui";
const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
import { render } from "svelte/server";
import type { ComponentProps } from "svelte";
import { ValidationError } from "@kozane/core";
import {
  StaticBackend,
  HttpBackend,
  BackendError,
  createDemoNavigation,
  DEFAULT_UI_CONFIG,
  validateUiOverrides,
  type UiConfig,
  type ValidationResult,
} from "@kozane/client";
import { BoardView as PublicBoard } from "@kozane/client/board";
import { TagsView as PublicTags } from "@kozane/client/tags";
import { MapView as PublicMap } from "@kozane/client/map";
import { FileEditor as PublicEditor } from "@kozane/client/editor";
import {
  cardMetrics,
  nearestCardHint,
  truncationReasons,
  type CardMetrics,
  type WarpListEntry,
} from "@kozane/client";
assert(BoardView === PublicBoard, "Board entry identity");
assert(TagsView === PublicTags, "Tags entry identity");
assert(MapView === PublicMap, "Map entry identity");
assert(FileEditor === PublicEditor, "Editor entry identity");
assert(DEFAULT_UI_CONFIG === uiDefaults, "UI configuration entry identity");
const validated: ValidationResult<Partial<UiConfig>> = validateUiOverrides({
  defaultCardWidth: 240,
});
// @ts-expect-error Card placement remains a closed union.
const invalidPlacement: UiConfig["newCardPlacement"] = "diagonal";
void validated;
void invalidPlacement;
const metrics: CardMetrics = cardMetrics(DEFAULT_UI_CONFIG);
const hint: string | null = nearestCardHint({ posX: 0, posY: 0 }, [], metrics);
const warp: WarpListEntry = {
  id: "w",
  namespaceId: "n",
  namespaceName: "N",
  label: 1,
  posX: 0,
  posY: 0,
  hint,
  isCurrent: true,
};
// @ts-expect-error Warp marker labels remain numeric.
const invalidWarp: WarpListEntry = { ...warp, label: "1" };
// @ts-expect-error Tag truncation reasons remain a closed union.
void truncationReasons(["unknown"]);
void warp;
void invalidWarp;
const doc = new EditorDocument("Packed editor 日本語");
const surfaceProps: ComponentProps<typeof EditorSurface> = {
  doc,
  caret: { line: 0, column: 0 },
  anchor: null,
};
const surface = render(EditorSurface, { props: surfaceProps });
assert(surface.body.includes("Packed editor 日本語"), "Editor SSR");
const namespaces = [{ id: "packed", name: "Packed workspace", isDefault: true }];
const backend = new StaticBackend({ namespaces });
const namespaceProps: ComponentProps<typeof NamespacesView> = {
  backend,
  initialNamespaces: namespaces,
  navigation: createDemoNavigation({ base: "/packed" }),
};
const namespaceHtml = render(NamespacesView, { props: namespaceProps }).body;
assert(namespaceHtml.includes("Packed workspace"), "Namespace SSR");
const fixture = createViewFixture();
export const viewFixtureHtml = {
  board: render(BoardView, { props: fixture.board }).body,
  tags: render(TagsView, { props: fixture.tags }).body,
  map: render(MapView, { props: fixture.map }).body,
};
assert(viewFixtureHtml.board.includes("Packed board 日本語"), "Board SSR");
assert(viewFixtureHtml.tags.includes("Packed board 日本語"), "Tags SSR");
assert(viewFixtureHtml.map.includes("General"), "Map SSR");
export const styleFixtureHtml = `<section id="packed-editor">${surface.body}</section><section id="packed-namespaces">${namespaceHtml}</section>`;
const http = new HttpBackend({
  capabilities: {
    writable: true,
    persistent: true,
    taskspaces: true,
    externalWrites: false,
    auth: false,
  },
  fetcher: async () => {
    throw new Error("Unexpected network dispatch");
  },
});
const coreError = new ValidationError("Public core identity");
const input = new Proxy(
  { width: 1 },
  {
    getPrototypeOf() {
      throw coreError;
    },
  },
);
let failure: unknown;
try {
  await http.cards.update("n", "c", input);
} catch (error) {
  failure = error;
}
assert(
  failure instanceof BackendError &&
    failure.code === "validation" &&
    failure.message === coreError.message,
  "Client must recognize a validation error created by the public core instance",
);
console.log(
  "Packed client public entries, editor/namespace SSR and core validation identity passed.",
);

function register(factory: BackendContractFactory) {
  for (const test of backendContractCases(factory)) {
    const run: () => Promise<void> = test.run;
    assert(
      typeof run === "function" && typeof test.name === "string",
      "Public contract case types",
    );
  }
}
void register;

function rejectInvalidViewData() {
  // @ts-expect-error Packaged tag counts retain their declared number/null type.
  fixture.tags.data.cardTotal = "invalid";
  // @ts-expect-error Packaged map zoom steps retain their declared number type.
  fixture.map.data.zoomStep = "invalid";
}
void rejectInvalidViewData;
