# Browser UI handbook

This handbook covers day-to-day work in the Kozane browser UI. It explains how to
navigate the canvas and how to create, arrange, and organize cards. For starting
the server and remote access, see the [README](../README.md) and the
[Security matrix](./security-matrix.md).

Everything here applies to a live server started with `kozane open`. A static
export made with `kozane net ssg generate` keeps pan, zoom, and filtering, but it
disables every operation that writes, including creating, editing, dragging,
deleting, gluing, scope membership, and working copies. It also stops the
live-sync poll, because there is no server to talk to.

## Opening a workspace

```sh
kozane open
```

This starts the server, which defaults to `http://127.0.0.1:5173`, and opens a
browser. The landing page lists the workspace's projects, and the workspace
default is tagged "Default". Click a project to open its canvas. If there are no
projects yet, the page tells you to run `kozane project create <name>`.

The back arrow at the top of the left panel returns to the project list.

## Layout

The project view has three parts.

- Left panel — bundles, where you filter, create, and delete.
- Canvas — the card workspace, with the composer and controls floating over it.
- Right panel — scopes and working copies.

Both side panels are hidden by default. Toggle them with the panels button in
the top-right corner or the `b` key. Toggle card footers with the neighbouring
footer button or the `f` key. These defaults, and the keys themselves, come from
the `ui` section of `.kozane/config.json`.

## Moving around the canvas

- Pan — click and drag any empty part of the canvas. The cursor is a grab hand.
- Zoom — hold `Ctrl` or `Cmd` and scroll to zoom toward the pointer, or use the
  `−` and `+` control in the bottom-right corner. Zoom ranges from 25% to 200%
  in 10% steps, and the current level shows next to the buttons.

Cards snap to a 24-pixel grid, so positions stay aligned as you work.

## Creating cards

The composer floats at the bottom-center of the canvas.

1. Click the input, or press `i` to focus it. Pressing `i` also clears any
   current selection.
2. Type the card text.
3. Press `Enter` to create the card. Use `Shift+Enter` for a line break inside a
   card, and `Esc` to unfocus the input.

New cards appear near the center of the current view, snapped to the grid.
Create several in a row and they fan out across a four-column layout instead of
stacking. The bundle dropdown at the top of the composer sets the new card's
bundle. If a bundle filter is active in the left panel, new cards inherit it, and
if a scope is active in the right panel, new cards are added to that scope
automatically.

## Editing a card

Double-click a card. The composer switches to edit mode, pre-filled with the
card's text and bundle. Change the text or pick a different bundle, then press
`Enter` to save or `Esc` to cancel.

## Selecting cards

- Click a card to select it. Clicking a glued card selects its whole glue group.
  Clicking the same card again clears the selection.
- Shift-click adds or removes a card, and its glue group, from the current
  selection.
- Shift-drag on empty canvas draws a rectangle, and every card it touches is
  selected.
- Click empty canvas to clear the selection. So does `Esc`.

The first card in a selection is the primary card, which some actions such as
"Unglue this" act on specifically.

## Acting on a selection

Whenever one or more cards are selected, the composer becomes an action bar
showing the selection count. The actions and their keyboard shortcuts:

| Action             | Key      | Availability                    |
| ------------------ | -------- | ------------------------------- |
| Change bundle      | none     | Any selection (bundle dropdown) |
| Copy card ID       | `c`      | Exactly one card selected       |
| Bring to front     | `]`      | Exactly one card selected       |
| Send to back       | `[`      | Exactly one card selected       |
| Glue or Unglue all | `g`      | Two or more cards selected      |
| Unglue this        | `u`      | Primary card is in a glue group |
| Move to project    | `m`      | Another project exists          |
| Delete             | `Delete` | Any selection                   |
| Clear selection    | `Esc`    | Any selection                   |

Shortcuts fire only when you are not typing in a text field. "Move to project"
opens a picker of the workspace's other projects, and choosing one moves every
selected card there.

## Arranging cards

- Drag a card to move it, and it snaps to the grid on release. Dragging a glued
  card moves its entire glue group, and dragging a card that is part of the
  current selection moves the whole selection together.
- Layering works on a single selected card. "Bring to front" (`]`) and "Send to
  back" (`[`) change which cards overlap on top.

Card positions and layer changes save automatically. If a save fails, an error
banner appears and the affected cards revert to where they were.

## Gluing cards

Glue binds cards into a group that selects and moves as one. Select two or more
cards and press `g`, or click "Glue". To break a group, select it and choose
"Unglue all", which is `g` again. To remove just the primary card from its group,
press `u`. Glued cards show a small link icon in their footer.

## Bundles

A bundle is a colored label on every card, a coarse category rather than a
folder. The left panel lists bundles with a card count each.

- Filter — click a bundle to show only its cards, and click "All cards", or the
  same bundle again, to clear the filter.
- Create — type a name in the input at the bottom of the panel and press `Enter`
  or the `+` button.
- Delete — hover a bundle and click the `×`. The default bundle cannot be
  deleted, and cards in a deleted bundle move to the project's default bundle.

## Scopes

A scope is a cross-project grouping of cards. The right panel lists scopes with a
member count each.

- Filter — click a scope to highlight its cards. Cards outside it are dimmed.
  Click again to clear.
- Create — type a name in the input at the bottom of the panel and press `Enter`
  or `+`.
- Add or remove cards — select cards, then use each scope's "Add to scope" or
  "Remove from scope" button. The label reflects whether the whole selection is
  already in that scope.
- Delete — hover a scope and click the `×`. This removes this project's cards
  from the scope. The cards themselves are kept, and the scope disappears
  workspace-wide only once no cards reference it.

## Working copies

A working copy is a filesystem directory tied to a scope, used to write scope
cards to disk. Open a scope in the right panel to see its working copies. To
create one, select the scope, type a name in the working-copy input, and press
`Enter` or `+`. A scope must be active first. Cards that belong to a working
copy show a `wc` badge in their footer. Manage working copies on disk with
`kozane wc scan` and `kozane wc create`, described in the
[CLI specification](../spec/cli.md).

## Card footers

Toggle footers with the footer button in the top-right corner or the `f` key. A
footer shows, when relevant, the glue-group link icon, the `wc` badge, and the
card's bundle dot and name.

## Live sync

The project view polls the server about once a second, and again whenever the tab
regains focus, to pull in changes made by the CLI or another browser tab. Updates
apply without disturbing your current filter or selection. Live sync is off in a
static export, which is a fixed snapshot with no server behind it.
</content>
