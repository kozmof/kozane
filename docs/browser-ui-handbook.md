# Browser UI handbook

This handbook covers day-to-day work in the Kozane browser UI. It explains how to
navigate the canvas and how to create, arrange, and organize cards. For starting
the server and remote access, see the [README](../README.md) and the
[Security matrix](./security-matrix.md).

Everything here applies to a live server started with `kozane open`. A static
export made with `kozane net ssg generate` keeps pan, zoom, and filtering, but it
disables every operation that writes, including creating, editing, dragging,
deleting, gluing, scope membership, and taskspaces. It also stops the
live-sync poll, because there is no server to talk to.

## Opening a workspace

```sh
kozane open
```

This starts the server, which defaults to `http://127.0.0.1:17173`, and opens a
browser. The landing page lists the workspace's projects, and the workspace
default is tagged "Default". Click a project to open its canvas. If there are no
projects yet, the page tells you to run `kozane project create <name>`.

The back arrow at the top of the left panel returns to the project list.

## Layout

The project view has three parts.

- Left panel — bundles, where you filter, create, and delete.
- Canvas — the card workspace, with the composer and controls floating over it.
- Right panel — scopes and taskspaces.

Both side panels are hidden by default. Toggle them with the panels button in
the top-right corner or the `b` key. Toggle card footers with the `f` key. These
defaults, and the keys themselves, come from the `ui` section of
`.kozane/config.json`.

## Moving around the canvas

- Pan — click and drag any empty part of the canvas. The cursor is a grab hand.
- Zoom — hold `Ctrl` or `Cmd` and scroll to zoom toward the pointer, or use the
  `−` and `+` control in the bottom-right corner. Zoom ranges from 25% to 200%
  using the configured `ui.zoomStep` (5% by default), and the current level
  shows next to the buttons.

Cards snap to a 24-pixel grid, so positions stay aligned as you work.

## Warps

A warp is a saved place on the canvas. Once a project has a few, the arrow keys
move the view between them, which beats dragging across a board several screens
wide. Warps belong to the project and are stored with it, so they are still
there after a reload and in another tab.

- Set — press `a`. A numbered marker appears under the mouse pointer, or at the
  centre of the view if the pointer is off the canvas. Warps are numbered in the
  order they were made.
- Warp — press `←`, `→`, `↑`, or `↓`. The view moves to the nearest warp in that
  direction and the marker highlights. Once there is none, the board wraps
  round: `→` off the rightmost warp arrives at the leftmost, and `↓` off the
  bottom one at the top, so a row of warps cycles under one key. Zoom is left as
  it is.
- Warp to another project — press `Shift` with any arrow key. A list of every warp
  in the workspace opens, grouped by project, with this project's warps first and
  each warp named after the card it sits on, or the nearest one when it sits on
  the bare board. `↑` and `↓` move through the list,
  `Enter` or a click jumps, and `Esc` closes it. A warp in this project just moves
  the view; a warp in another project opens that project's board already centred on
  it. The direction pressed does not matter — all four open the same list. Each row
  has a remove button, which is the only way to remove another project's warps
  without going there.
- Remove — the highlighted warp is the selected one, and `x` removes it. Click a
  marker to select it without moving. The remaining warps renumber.
- Show or hide — press `Shift+A`. Setting a warp shows the markers again, so a
  warp you just made is never invisible.
- Size — markers are 20 pixels across. Set `ui.warpMarkerSize` (8 to 64) to make
  them bigger or smaller; the number inside scales with the circle.

Warp keys work when no cards are selected: while a selection is live, the
composer's action bar owns the keyboard. A static export keeps warping — the
cross-project list included — and the show/hide toggle, and drops setting and
removing along with every other write.

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
- Stacking order works on a single selected card. "Bring to front" (`]`) and
  "Send to back" (`[`) change which cards overlap on top, within the card's own
  layer.

Card positions and stacking changes save automatically. If a save fails, an
error banner appears and the affected cards revert to where they were.

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

## Layers

A layer is a surface a card sits on, so one set of cards can be worked on
without the rest getting in the way. Every card belongs to exactly one layer of
its project, and every project starts with a layer named `Base`.

One layer is selected at a time. Its cards are drawn at full strength above all
the others, and the remaining layers fade well back, in their own order. Cards
on a dimmed layer stay live: you can still click, drag, and edit them, and a
card you drag rises above the layers on top of it and comes back to full
strength while it moves. "Bring to front" and "Send to back" reorder a card
within its own layer.

Layers live behind the button at the top right of the canvas, next to the panel
toggle.

- Select — hover the button and click a layer in the popover. Click the button
  itself to keep the popover open while you work in it.
- Create — type a name in the popover input and press `Enter` or the `+` button.
  The new layer goes on top and becomes the selected one.
- Rename — double-click a layer, type, and press `Enter`. `Escape` abandons the
  edit. With the row focused, `F2` starts the same edit.
- Reorder — drag a layer up or down the list, which is ordered top of the stack
  first. The grip on the left of each row also moves the layer with `↑` and `↓`
  when it has focus.
- Delete — hover a layer and click the `×`. The default layer cannot be deleted,
  and cards on a deleted layer move to the project's default layer.

New cards are created on the selected layer, and the selection is remembered, so
reopening the page comes back to the layer you were working on.

To move cards you have already written, select them and pick a layer from the
control beside the bundle picker in the composer. The selection moves with them,
so the board follows the cards to their new layer.

From the terminal, `kozane layer list|add|rename|move|delete` manages layers,
`kozane card add --layer <name>` chooses where a card lands, and
`kozane card layer <cardId> <layer>` moves an existing card. Everywhere a layer
is named, its name, ID, or short ID all work, and an exact name wins.

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

## Taskspaces

A taskspace is a filesystem directory tied to a scope, used to write scope
cards to disk. Open a scope in the right panel to see its taskspaces. To
create one, select the scope, type a name in the taskspace input, and press
`Enter` or `+`. A scope must be active first. Cards that belong to a working
copy show a `taskspace` badge in their footer. Manage taskspaces on disk with
`kozane taskspace scan` and `kozane taskspace create`, described in the
[CLI specification](../spec/cli.md).

## Card footers

Toggle footers with the `f` key. A footer shows, when relevant, the glue-group
link icon, the `taskspace` badge, and the card's bundle dot and name.

## Live sync

The project view polls the server about once a second, and again whenever the tab
regains focus, to pull in changes made by the CLI or another browser tab. Updates
apply without disturbing your current filter or selection. Live sync is off in a
static export, which is a fixed snapshot with no server behind it.
</content>
