# Browser UI handbook

Start by adding cards. Use other structures only when you need them.
For installation and remote access, see the [README](../README.md).

## Opening a workspace

Run `kozane open` to start the server and open the browser at
`http://127.0.0.1:17173` by default. Choose a namespace to open its canvas.
The default namespace is marked "Default".

To create a namespace, enter a name below the list and click `+`. It starts with
the "General" partition and "Base" layer. The back arrow in the left panel
returns to the namespace list.

## Creating cards

The composer sits at the bottom of the canvas.

1. Click the input or press `i`, which also clears the current selection.
2. Type your text.
3. Press `Enter` to create a card. Use `Shift+Enter` for a line break and `Esc`
   to leave the input.

Cards appear near the center of the view and stack downward. New cards use the
selected layer, partition, and scope, if any.

## Editing a card

Double-click a card to edit its text or partition in the composer.
Press `Enter` to save or `Esc` to cancel.

## Moving around the canvas

- Pan by dragging empty canvas.
- Zoom with `Ctrl` or `Cmd` and scroll, or use the bottom-right `−` and `+`
  buttons. The range is 25% to 200%.

## Selecting cards

- Click a card to select it, or click it again to clear the selection.
- Shift-click to add or remove cards.
- Shift-drag on empty canvas to select every card the rectangle touches.
- Click empty canvas or press `Esc` to clear the selection.

Selecting a glued card selects its group. The first selected card is the primary
card, used by actions such as "Unglue this".

## Acting on a selection

Selecting cards turns the composer into an action bar. Shortcuts work when you
are not typing in a text field.

| Action             | Key                | Availability               |
| ------------------ | ------------------ | -------------------------- |
| Change partition   | Partition dropdown | Any selection              |
| Copy card ID       | `c`                | One card                   |
| Bring to front     | `]`                | One card                   |
| Send to back       | `[`                | One card                   |
| Glue or Unglue all | `g`                | Two or more cards          |
| Unglue this        | `u`                | Primary card is glued      |
| Move to namespace  | `m`                | Another namespace exists   |
| Resize             | `r`                | One card                   |
| Squash             | `s`                | One card whose text splits |
| Edit a file        | `e`                | Any selection              |
| Delete             | `Delete`           | Any selection              |
| Clear selection    | `Esc`              | Any selection              |

"Move to namespace" opens a picker and moves all selected cards to your choice.

## Arranging cards

Drag a card to move it. Glued groups and selected cards move together.
Positions snap to a 24-pixel grid. "Bring to front" and "Send to back" change
stacking order within the card's layer.

Changes save automatically. If saving fails, an error banner appears and the
affected cards return to their previous positions.

## Resizing a card

Select one card and press `r`, then drag its right-edge handle. Widths snap to
the grid and range from 40 to 1200 pixels. Press `r` again, click "Done resizing",
or clear the selection to finish.

Unresized cards follow `ui.defaultCardWidth`, which defaults to 210 pixels.
Resizing a glued card changes only that card.

## Squashing a card into its pieces

Select a card and press `s` to split it on periods followed by whitespace,
`。`, or blank lines. Dots inside URLs such as `example.com` stay intact.
"Squash" is disabled when there is nothing to split.

The pieces replace the original and remain selected. They inherit its partition,
layer, width, and scopes, but start with new histories and no glue group.
Pieces are placed beside and below the original position. Drag any that overlap.

## Gluing cards

Select two or more cards and press `g` to make them select and move as a group.
Press `g` again to unglue the group, or `u` to remove only the primary card.
A link icon in the footer marks glued cards.

## Layout

The left panel holds partitions. The right panel holds scopes and taskspaces.
Both are hidden by default. Use the top-right panels button or press `b` to
show or hide them.

Press `f` to toggle card footers, which show the partition, glue icon, and
`taskspace` badge when applicable.

## Partitions

Every card has a partition. The left panel lists partitions and their card counts.

- Filter by clicking a partition. Click it again or choose "All cards" to clear.
- Create one by entering a name at the bottom and pressing `Enter` or `+`.
- Delete one by hovering its row and clicking `×`. Its cards move to the default
  partition, which cannot be deleted.

## Layers

Each card belongs to one layer. Open the layers popover beside the panel toggle
at the top right. Click the button to keep it open.

- Select a layer by clicking its row. New cards use it, and the choice is remembered.
- Create one by entering a name and pressing `Enter` or `+`.
- Rename one by double-clicking it or focusing its row and pressing `F2`.
  Press `Enter` to save or `Esc` to cancel.
- Reorder layers by dragging rows, or focus a row's grip and use `↑` and `↓`.
- Delete one with its hover `×`. Its cards move to the default layer, which
  cannot be deleted.

The selected layer appears above the others. Dimmed cards remain editable.
To move existing cards to another layer, select them and use the layer control
beside the composer's partition picker.

## Scopes

Scopes group cards across namespaces. The right panel shows scopes used by this
namespace's cards or taskspaces, plus scopes not yet used anywhere. Counts refer
to cards in the current namespace.

- Click a scope to highlight its cards, and click again to clear.
- Create one by entering a name and pressing `Enter` or `+`.
- Select cards and use "Link" or "Unlink" to change their membership.
- Click a scope's hover `×` to remove this namespace's cards from it. Cards are
  kept. The scope is deleted workspace-wide only when no cards, taskspaces, or
  frames refer to it.

### Scope areas

A scope area is a named frame on the canvas. A scope can have several frames
on each board.

- Add a frame by Alt-dragging on the canvas, then choosing or naming a scope.
  Press `Esc` to cancel. Overlapping cards join the scope.
- Move a frame by dragging its tab. Its cards travel with it.
- Resize it with the corner handle.
- Remove it with the `×` beside its tab. Removing a frame keeps its cards in
  the scope and leaves other frames intact.

Crossing into a frame adds a card to the scope. Crossing out removes it only
when it is outside every frame of that scope. Moving or resizing a frame also
updates membership. Cards linked through the panel can remain outside all frames
without losing membership until they cross a frame edge.

Frames belong to individual boards and stay visible across layers. A `▣` on a
scope row indicates frames on this board, with a count when there is more than one.

#### Files on a frame

A framed scope's taskspaces appear as file and folder icons below the frame.
Click a file to edit it, or a folder to browse it. Use `‹ back` to go up.
Each frame remembers its own folder.

Icons show at most two rows. Use the right panel for the full listing or to
refresh it. Symbolic links cannot be opened.

## Taskspaces

A taskspace is a filesystem directory tied to a scope. Select a scope in the
right panel to see its taskspaces. To create one, enter a name and press
`Enter` or `+`.

The panel shows this namespace's taskspaces and those with no namespace.
For workspace-wide listing and disk management, see the
[CLI specification](../spec/cli.md).

### Browsing a taskspace

Click a taskspace or folder to expand it. Dotfiles and dot-directories are hidden,
and symbolic links cannot be opened. Listings stop at 500 entries and show a
notice when shortened.

Disk changes do not refresh automatically. Hover an open taskspace and click
`⟳` to refresh its tree and frame icons.

### Opening a file from a selection

Select cards and press `e` to open "Edit a file". The panel lists the board's
scopes, taskspaces, and files. Click a file to edit it. Click scope or taskspace
names to fold their trees.

A scope shows "Linked" when it contains every selected card. Otherwise, use its
link button to add the remaining cards while keeping the selection.

To create a scope, taskspace, and file together, fill in the three fields at the
bottom. `Enter` advances through them and creates everything from the File field.
The selected cards join the new scope, and the empty file opens in the editor.
Scope names must be unique workspace-wide, and the taskspace directory name must
be available. Errors appear in the panel.

Press `Esc` or click outside to close.

### Adding a file or folder

Hover a taskspace or folder and use its new-file or new-folder control.
Enter one name and press `Enter` to create, or `Esc` to cancel.
Names cannot contain `/` or start with a dot. Existing entries are never replaced.
New files open in the editor immediately.

### Editing a file

Click a text file to open the editor. Files must be valid UTF-8 and at most 1 MB.

| Action       | Control                                                 |
| ------------ | ------------------------------------------------------- |
| Save         | `Ctrl+S`, `Cmd+S`, or Save                              |
| Undo         | `Ctrl+Z` or `Cmd+Z`                                     |
| Redo         | `Ctrl+Shift+Z` or `Cmd+Shift+Z`                         |
| Close        | `Esc`, Close, or click outside                          |
| Resize panel | Drag its left edge, or focus the edge and use `←` / `→` |

A dot beside the path marks unsaved changes. Closing the editor or leaving the
page asks before discarding them. Closing the editor ends its undo history.
The panel width is remembered until the tab reloads.

If the file changes on disk while you edit, saving is refused. Reloading from
disk discards your unsaved edits.

Set `ui.editorVimMode` to `true` in `.kozane/config.json` for Vim bindings.
The editor opens in normal mode. `Esc` leaves insert mode, and saving stays on
`Ctrl+S` or `Cmd+S`.

## Warps

Warps save places on a namespace's canvas and persist across reloads.
Use these shortcuts with no cards selected and no text field focused.

| Action                                  | Control                            |
| --------------------------------------- | ---------------------------------- |
| Set a warp                              | `a`, at the pointer or view center |
| Jump to the nearest warp in a direction | Arrow keys, wrapping at the edge   |
| Open the workspace-wide warp picker     | `Shift` + any arrow key            |
| Move a warp                             | Drag its marker                    |
| Remove the selected warp                | `x`                                |
| Show or hide markers                    | `Shift+A`                          |

In the picker, use `↑` / `↓` and `Enter`, or click a row, to jump.
Press `Esc` to close. Each row also has a remove button.
Click a marker to select it. Jumping preserves zoom.

## Inventories

An inventory stores cards off the canvas in a grid. On the canvas it is
a box icon with a badge counting its cards. Use the shortcut with no cards selected and no
text field focused.

| Action                          | Control                                 |
| ------------------------------- | --------------------------------------- |
| Add an inventory                | `v`, at the pointer or view center      |
| Open or close it                | Click its icon                          |
| Move the icon                   | Drag it                                 |
| Store cards                     | Drag a card onto the icon or a slot     |
| Rearrange cards                 | Drag a card to another slot             |
| Take a card out                 | Drag it from the grid onto the canvas   |
| Rename it                       | Double-click its name, or focus it and press `F2` |
| Close or remove it              | The `×` or bin button on its window     |

Open inventories appear on the left of the canvas and stay put while you pan, so cards can
be carried in from anywhere on the board.

While an inventory is open, new cards from the composer go into its first free slot, and
the composer shows "Add to" and the inventory's name. With several open, the one opened
last takes them. Close every inventory to add cards to the canvas again.

The grid is six columns wide. A card takes one column and as many rows as its text needs
to show in full, up to eight. Longer text scrolls inside the card. Cards fill the grid left
to right and top to bottom at the first place they fit, and a new row opens below the
lowest card.

Dropping a card on free cells puts it there. Dropping it on cells another card holds swaps
the two when each fits where the other was. Otherwise the cards in the way move to the
first place they fit. Dropping on the icon or the window header uses the first place the
card fits. Dragging a selected or glued card stores the whole group.

Editing a stored card can make it taller. If it then reaches cells another card holds, it
moves to the first place it fits.

A stored card keeps its partition, layer, and scopes, but leaves its glue group. Click it
in the grid to select it for the composer's actions, and double-click it to edit it.
A card taken out lands under the pointer and joins any scope frame it lands in.

Removing an inventory puts its cards back on the canvas where they were before they were
stored. Moving a card to another namespace takes it out of its inventory the same way.

## Tags

Write tags in card text, such as `:perf` or `:perf:cache`. Parent tags include
all their children. Tags are case-insensitive and exist only while used in text.
Click a tag in a card to open the tag index.

Tags start at the beginning of a line, after whitespace, or after an opening
bracket. Ordinary punctuation such as `3:45`, `key: value`, and URLs stays plain
text. Each level allows letters, digits, `-`, and `_`, up to 64 characters and
8 levels. Source-code symbols such as `:active` can also appear as tags.

### The tag index

Open `/tags` or click the tree icon in a page header. Choose a tag in the left
panel to see matching cards and taskspace files.

- Click a card result to open its board centered on the card.
- Click a file result to open it in the editor.
- Click a namespace name to narrow results. Click it again to clear.

Card tag links open the index narrowed to that card's namespace.
The URL keeps the selected tag and namespace for sharing.

Tree counts are distinct cards and files. Results show at most 200 card hits and
200 file hits per tag. Repeated matches can share a row. Notices identify
shortened results or incomplete scans. Choose a child tag to narrow results.

File scans skip hidden entries, symbolic links, non-text files, files over 1 MB,
and generated or vendored directories such as `node_modules`, `build`, and
`vendor`. They do not use `.gitignore`.

## The map

Open `/map` or click the unequal-rectangles icon for a read-only workspace view.

- Rectangles represent namespaces and their partitions, sized by card count.
  Empty ones have dashed outlines.
- Scope circles connect to the partitions or namespaces they reach. Hover a
  circle to highlight its connections.
- Click a tag to highlight the partitions containing it. Click again to clear.
  Map tags count cards only.
- Click a namespace name to narrow the view.

Drag to pan. Use `Ctrl` or `Cmd` and scroll, or the zoom buttons, to zoom from
50% to 400%. Click the percentage to reset the view.

The activity grid shows a trailing year of card changes by UTC day. Darker cells
mean more activity. Click a day to size the map and filter tags by cards changed
that day. Moving or resizing cards does not count as a change.
Click the day again or choose "Clear" to reset.
The URL keeps the selected namespace, tag, and day for sharing.

## Getting between the pages

Use the header icons to switch pages. Hover an icon to see its name.

| Icon               | Destination    |
| ------------------ | -------------- |
| Four-square grid   | Namespace list |
| Unequal rectangles | Map            |
| Branching tree     | Tag index      |

On the map and tag index, the grid returns to the selected namespace's board
when narrowed to one, or to the namespace list otherwise.

## Settings

UI settings live under `ui` in `.kozane/config.json`.

| Setting               | Purpose                                | Default         |
| --------------------- | -------------------------------------- | --------------- |
| `newCardPlacement`    | `vertical-list` or four-column `grid`  | `vertical-list` |
| `defaultCardWidth`    | Width of unresized cards in pixels     | `210`           |
| `zoomStep`            | Zoom increment                         | `0.05` (5%)     |
| `warpMarkerSize`      | Marker size in pixels, from 8 to 64    | `20`            |
| `setWarpShortcut`     | Set a warp                             | `a`             |
| `toggleWarpsShortcut` | Show or hide warps                     | `A` (Shift+A)   |
| `removeWarpShortcut`  | Remove a warp                          | `x`             |
| `addInventoryShortcut` | Add an inventory                     | `v`             |
| `editorVimMode`       | Enable Vim bindings in the file editor | `false`         |

## Live sync

The canvas checks for database changes about once a second and when the tab
regains focus. Updates from the CLI or other tabs preserve your filter and
selection. Taskspace directory listings require manual refresh.

## Static exports

Static exports support browsing, pan, zoom, filtering, warp navigation, and opening
inventories.
Creating, editing, moving, and deleting are disabled, and there is no live sync.

Scopes, taskspaces, and file-tag results are included only when exported with
`--include-scoped-files`. Included files can be browsed read-only.
For publishing instructions, see the [README](../README.md#publishing-a-read-only-static-site).
