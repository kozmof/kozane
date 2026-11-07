import "@kozane/client/styles.css";
import { hydrate, tick } from "svelte";
import { BoardView, TagsView, MapView } from "@kozane/client/ui";
import { createViewFixture } from "./view-fixture.js";
const fixture = createViewFixture({
  beforeNavigate: () => {},
  navigate: async (url) => {
    document.body.dataset.navigation = String(url);
  },
  replace: (url) => {
    document.body.dataset.navigation = url;
  },
});
const target = document.getElementById("packed-view")!;
switch (document.body.dataset.view) {
  case "board":
    hydrate(BoardView, { target, props: fixture.board });
    break;
  case "tags":
    hydrate(TagsView, { target, props: fixture.tags });
    break;
  case "map":
    hydrate(MapView, { target, props: fixture.map });
    break;
  default:
    throw new Error("Unknown packed view");
}
await tick();
document.body.dataset.packagedClient = "ready";
