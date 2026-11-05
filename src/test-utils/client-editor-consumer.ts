import { render } from "svelte/server";
import {
  EditorDocument,
  EditorSession,
  EditorSurface,
  FileEditor,
} from "../lib/client/editor/index.js";
import type { NavigationDriver } from "../lib/navigation.js";

import { staticEditorContext } from "./editor-context.js";

export async function renderEditor() {
  const doc = new EditorDocument("Shared editor SSR\n");
  const surface = render(EditorSurface, {
    props: { doc, caret: { line: 0, column: 0 }, anchor: null },
  });
  const routing: NavigationDriver = {
    beforeNavigate: () => () => {},
    navigate: async () => {},
    replace: () => {},
  };
  const ctx = staticEditorContext(
    {
      t: {
        root: {
          kind: "directory",
          name: "",
          children: [{ kind: "file", name: "notes.md", content: "Shared editor SSR\n", size: 18 }],
          truncated: null,
        },
      },
    },
    "n",
  );
  const session = new EditorSession();
  await session.open(ctx, { taskspaceId: "t", taskspaceName: "Notes", path: "notes.md" });
  const panel = render(FileEditor, {
    props: {
      session,
      ctx,
      readonly: true,
      routing,
      onClose: () => {},
    },
  });
  return { surface: surface.body, panel: panel.body };
}
