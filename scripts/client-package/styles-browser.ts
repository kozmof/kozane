import { verifyCoreIdentity } from "./verify-core-identity.mjs";
import "@kozane/client/styles.css";
import { hydrate, tick } from "svelte";
import { EditorDocument, EditorSurface, NamespacesView } from "@kozane/client/ui";
import { StaticBackend, createDemoNavigation } from "@kozane/client";
const doc = new EditorDocument("Packed editor 日本語");
const namespaces = [{ id: "packed", name: "Packed workspace", isDefault: true }];
hydrate(EditorSurface, {
  target: document.getElementById("packed-editor")!,
  props: { doc, caret: { line: 0, column: 0 }, anchor: null },
});
hydrate(NamespacesView, {
  target: document.getElementById("packed-namespaces")!,
  props: {
    backend: new StaticBackend({ namespaces }),
    initialNamespaces: namespaces,
    navigation: createDemoNavigation({ base: "/packed" }),
  },
});
await verifyCoreIdentity();
await tick();
document.body.dataset.packagedClient = "ready";
