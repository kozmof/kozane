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
default is tagged "Default". Click a project to open its canvas.

To start a new project, type a name into the field below the list and press
the "+" button beside it, the same as creating a bundle or a layer. It arrives
with the default "General" bundle and "Base" layer, the same as
`kozane project create <name>`, and appears in the list ready to open. A
read-only static export has no server to create anything, so it shows the CLI
command instead of the field.

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
  center of the view if the pointer is off the canvas. Warps are numbered in the
  order they were made. One press makes one warp, however long the key is held.
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
  the view. A warp in another project opens that project's board already centered
  on it. The direction pressed does not matter, since all four open the same list.
  Each row has a remove button, which is the only way to remove another project's
  warps without going there.
- Remove — the highlighted warp is the selected one, and `x` removes it. Click a
  marker to select it without moving. The remaining warps renumber.
- Show or hide — press `Shift+A`. Setting a warp, or warping to one, shows the
  markers again, so the warp that `x` removes is never invisible.
- Size — markers are 20 pixels across. Set `ui.warpMarkerSize` (8 to 64) to make
  them bigger or smaller, and the number inside scales with the circle.

Warp keys work when no cards are selected. While a selection is live, the
composer's action bar owns the keyboard. They are single keys, so a shortcut held
with `Ctrl`, `Cmd`, or `Alt` does nothing, and `Cmd+A` still selects text rather
than dropping a warp. The letters are `ui.setWarpShortcut`,
`ui.toggleWarpsShortcut`, and `ui.removeWarpShortcut` in `.kozane/config.json` and
can be rebound. The arrow keys cannot, since they are what moves between warps. A
static export keeps warping, including the cross-project list, and the show/hide
toggle. It drops setting and removing along with every other write.

## Creating cards

The composer floats at the bottom-center of the canvas.

1. Click the input, or press `i` to focus it. Pressing `i` also clears any
   current selection.
2. Type the card text.
3. Press `Enter` to create the card. Use `Shift+Enter` for a line break inside a
   card, and `Esc` to unfocus the input.

New cards appear near the center of the current view, snapped to the grid.
Create several in a row and they stack downward in one column without
overlapping. Set `ui.newCardPlacement` to `"grid"` in `.kozane/config.json` for a
compact four-column layout instead. The bundle dropdown at the top of the
composer sets the new card's bundle. If a bundle filter is active in the left
panel, new cards inherit it, and if a scope is active in the right panel, new
cards are added to that scope automatically.

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
| Resize             | `r`      | Exactly one card selected       |
| Squash             | `s`      | One card whose text splits      |
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

## Resizing a card

Every card is drawn at `ui.defaultCardWidth`, 210 pixels by default, and change
that setting and the whole board follows it. A single card can be given a width
of its own instead.

Select one card and press `r`, or click "Resize". A handle appears on the card's
right edge. Drag it to set the width, which snaps to the same 24-pixel grid
positions do, and the new width saves when you let go. Widths run from 40 to
1200 pixels. Press `r` again, click "Done resizing", or clear the selection to
put the handle away — the width you set stays either way.

Resizing acts on the one selected card, including a card in a glue group: glue
binds where cards are, not how wide they are. A card you have never resized has
no width of its own and goes on following `ui.defaultCardWidth`. A static export
draws the widths it was built with but cannot change them, like every other
write.

## Squashing a card into its pieces

A card you wrote in one go often holds several thoughts. Squashing splits it into
one card per thought, which is the kozane method's own move: small cards you can
arrange.

Select one card and press `s`, or click "Squash". The text is split on `. ` (a
period followed by a space), `。`, or a blank line — the same rule
`kozane card squash` uses, so dots inside `example.com` are left alone. Each
segment becomes a card, and the original is removed. The whole thing is one
transaction: either every piece is on the board or the card is untouched.

The first piece takes the place the card was in, and the rest are laid out to its
right and below, skipping positions other cards already sit on. Because the split
happens before the pieces are drawn, they are spaced rather than measured, and a
long piece can overlap the one below it until you drag it. Every piece inherits
the card's bundle, layer, and width, and joins every scope the card was in. The
pieces are left selected, so the next action applies to all of them at once.

What the pieces do not inherit is the card's history: each is a new card, created
when you squashed it. `kozane card list --sort created` lists them as written
today, whatever the card they came out of had stood since.

"Squash" is greyed out for a card whose text has nothing to split on: squashing
it would replace the card with a copy under a new ID for no gain. A card in a
glue group can still be squashed — the card leaves the group on its way out, and
the pieces start unglued.

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
on a dimmed layer stay live. You can still click, drag, and edit them, and a
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

A scope is a cross-project grouping of cards. The right panel lists scopes
with a member count each. The count is this project's cards in the scope,
not the scope's total.

A scope can hold cards from several projects, but the panel lists only the
ones this project has reason to draw: scopes holding one of its cards,
scopes one of its taskspaces is attached to, and scopes nothing anywhere
refers to yet — so a scope you have just named, and not yet filed anything
into, stays put. A scope only another project is working in is not shown.
Run `kozane scope list` to see every scope in the workspace and which
projects reach each one.

- Filter — click a scope to highlight its cards. Cards outside it are dimmed.
  Click again to clear.
- Create — type a name in the input at the bottom of the panel and press `Enter`
  or `+`.
- Add or remove cards — select cards, then use each scope's "Add to scope" or
  "Remove from scope" button. The label reflects whether the whole selection is
  already in that scope.
- Delete — hover a scope and click the `×`. This removes this project's cards
  from the scope. The cards themselves are kept, and the scope disappears
  workspace-wide only once nothing anywhere refers to it — no cards in any
  project, and no taskspaces.

## Taskspaces

A taskspace is a filesystem directory tied to a scope, used to write scope
cards to disk. Open a scope in the right panel to see its taskspaces. To
create one, select the scope, type a name in the taskspace input, and press
`Enter` or `+`. A scope must be active first. Cards that belong to a working
copy show a `taskspace` badge in their footer.

The taskspaces under a scope are narrowed like the scopes themselves: this
project's, plus any that belong to no project. Run `kozane taskspace list`
to see every taskspace in the workspace with the project it belongs to.
Manage taskspaces on disk with `kozane taskspace scan` and
`kozane taskspace create`, described in the
[CLI specification](../spec/cli.md).

### Browsing a taskspace

Click a taskspace to open its directory tree. Folders open one at a time, each
read when you first click it, so a taskspace holding a large checkout costs
nothing until you go looking inside it. A folder you close keeps what it read,
and opening it again is immediate.

Listing a directory reads only names, sizes, and modification times. Dotfiles and
dot-directories are hidden, so `.taskspace.json`, `.git`, and an `.env` are all
left out, and none of them can be opened by typing the name either. A symbolic
link is listed as itself and cannot be opened, because following one is not
something a read confined to the taskspace can do.

The tree does not refresh on its own — live sync watches the database, not the
disk. Hover an open taskspace and click `⟳` to re-read it. A directory of more
than 500 entries is cut off, and the panel says so at the end of the listing.

### Editing a file

Click a file to open it in an editor panel over the canvas. Type into it and
press `Ctrl+S` or `Cmd+S` to save, or use the Save button in the panel header. A
dot beside the path means there are unsaved changes.

Close the panel with `Esc`, the Close button, or a click anywhere outside it.
Over an unsaved change all three ask first, offering to keep editing or to
discard and close, since closing ends the editing session and takes its undo
history with it. A second `Esc` backs out of the question.

Drag the panel's left edge to make it wider or narrower, or focus the edge and
use `←` and `→`. The width lasts as long as the tab is open, including across
closing one file and opening another, and starts from the default again after a
reload.

Only text files can be opened, and only up to 1 MB. A file larger than that, or
one that is not valid UTF-8, is refused rather than truncated or mangled: the
panel writes back what it holds, so anything it could not read exactly is
something it must not be allowed to save over. Saving replaces an existing file
and never creates one; there is no way to add a file from the browser.

The file is read when it is opened, and the save is checked against what is on
disk at that moment. If the file changed underneath — another editor, a build, a
`git checkout` — the save is refused and the panel offers to reload from disk.
Reloading discards what is in the editor, which is the point: the alternative is
silently throwing away the change that arrived while you were typing.

Undo and redo are `Ctrl+Z` and `Ctrl+Shift+Z` (or `Cmd`), and the history belongs
to the editing session rather than to the file — closing the panel ends it. Undo
moves the caret to the edit it takes back, so what changed is on screen rather
than somewhere you have to go looking for.

A run of typing comes back in one press rather than a character at a time.
Consecutive edits are joined into one entry while they continue each other; a
pause, a move to somewhere else in the file, or a switch from typing to deleting
each start a new one.

Set `ui.editorVimMode` to `true` in `.kozane/config.json` for vim key bindings.
The panel then opens in normal mode, and the status bar shows which mode it is
in. The bindings are `hjkl`, `w`/`b`/`e`, `0`/`^`/`$`, `gg`/`G`, `i`/`a`/`I`/`A`,
`o`/`O`, `x`, `dd`, `u`, and `Ctrl+r`. `Esc` leaves insert mode rather than
closing the panel. Saving stays on `Ctrl+S` in both modes.

A static export made with `kozane net ssg generate` has no server to read a file
from, so the rows stay inert there and clicking one does nothing.

## Tags

A tag is a word you write inside a card, opened with an apostrophe: `'perf`. It gathers
that card with everything else carrying the same tag — including taskspace files, since a
tag is just text and a file is too.

Subcategorize with colons. `'perf:cache` sits under `'perf`, and `'perf` gathers it: pick
the parent to see everything beneath it, or the child to narrow down. There is nothing to
set up first. A tag exists because someone wrote it, and stops existing when the last text
holding it is edited or deleted.

An apostrophe is ordinary punctuation too, so `don't` is a word and `'quoted'` is a quoted
word — neither becomes a tag. A tag opens after a space or at the start of a line, and a
closing apostrophe cancels it. A link is an address rather than text, so
`https://example.com/it's/fine` is one link and no tag — and a tag written against a link
stops where it starts, which makes `'todo:https://example.com` the tag `'todo` and
`'https://example.com` no tag rather than the tag `'https`. Levels take letters, digits,
`-`, and `_`, up to 64 characters each and 8 levels deep; past either, it is not treated as
a tag at all. `'Perf` and `'perf` are the same tag.

The cancelling rule reaches one word, so an apostrophe opening something longer is still a
tag: `'a phrase'` gathers under `'a`, and so do `'til` and `'90s`. The rule errs this way on
purpose — a tag nobody meant is one row you can ignore, while a tag quietly swallowed is a
card you cannot find.

Tags in a card's text are drawn as links. Click one to open the tag index.

### The tag index

The tag index lives at `/tags`. There are two ways in: the tree icon in the corner of the
project list, which opens it on the whole workspace, and any tag on a card, which opens it
on that tag. It has two halves: the tree of
every tag on the left, with a count of the cards and files each one gathers, and the selected
tag's hits on the right. `?tag=` says which tag is open, so any view of the page is a link
you can send.

It reaches the whole workspace by default. Unlike a board, which draws one project, the
index gathers every project's cards and every taskspace at once — a tag lives in the text
rather than in a table, so nothing stops the same one being used on two boards.

The row of project names in the top right narrows it. Picking one adds `?projectId=<id>` to
the URL and reduces the tree to that project's cards and the taskspaces its board draws;
picking the one already selected clears it again and goes back to the whole workspace. The
narrowing sticks as you browse the tree. A tag link in a card opens the index already
narrowed to that card's project.

**Cards only**, beside the project names, puts the taskspace files down and leaves the tags
written on cards. It adds `?files=0` to the URL and skips the disk walk rather than hiding
what it found, so it is also the quickest the page gets. It is the answer for a taskspace
that is a source checkout: a tag is just text, so every multi-word quoted string in one
opens a tag under its first word — `echo 'hello world'` gathers under `'hello` — and the tree
over such a taskspace is largely that. **Include files** puts them back.
`kozane tag show --no-files` is the same switch in the terminal.

- Cards show their text and bundle, and their project when you are looking across the
  whole workspace. Click one to go to that card's board with the view centered on it.
- Files show the path, the line number, and the line the tag is on. Click one to open it in
  the file editor.

Counts are of distinct cards and files. A card carrying `'perf` twice is one card, and it
appears once in the list, labelled with each tag it matched.

Taskspace files are read when you open the page, within the same limits the taskspace panel
works under: dot-entries like `.git` and `.env` are never read, symlinks are never
followed, and a file that is not text or is over 1 MB is skipped. Files that have not
changed since the last read are not read again, so coming back to the page is quick. A
taskspace too large to read in full says so at the bottom of the list, rather than leaving
you to think a tag is missing. When the reason is about particular files it names a few of
them, so you can go and look; a name ending in `/` is a directory that could not be listed.
The cards have a ceiling of their own — a hundred thousand hits for one gather — and it is
reported in the same place, for the same reason.

Generated and vendored directories are left out as well — `node_modules`, `build`, `dist`,
`out`, `target`, `coverage`, `vendor`, `bower_components`, `__pycache__`, and `tmp`, at any
depth.
They hold no text anyone wrote a tag in, and they are large enough that scanning them means
running out of budget before reaching the files you work on. A `.gitignore` is deliberately
not consulted: what you would rather not commit and what you would rather not tag are
different questions, and notes and drafts are often on the wrong side of it.

One tag's list shows at most 200 card hits and at most 200 file hits. The two limits are
separate on purpose: a tag written on thousands of cards would otherwise use up a single
limit before the files were reached, and the list would look as though the tag were in no
file at all. The count beside the tag in the tree is always the true one, so a shortened
list says which part of it you are looking at; pick a subcategory to narrow down to the rest.
`kozane tag show` holds the same two ceilings and says the same thing when it cuts a list.

The limits count hits rather than rows, and the notice says so, because a card carrying a
tag twice is two hits and one row. So a cut list can show slightly fewer rows than the
number it names — the count in the tree, which is of cards and files, is the one to read
for how much is under a tag.

A static export made with `kozane net ssg generate` carries one tag index for the whole
workspace, covering the cards on every exported board, and both the tag and the project
narrowing keep working there. Tags in taskspace files are left out unless the export was
built with `--include-scoped-files`, because a file hit names a path inside the workspace
and quotes a line of that file. The same flag governs whether the export names your
taskspaces at all — without it, an exported tag index mentions no taskspace, the same as an
exported board does not.

## The map

The map lives at `/map`, reached from the icon in the corner of the project list: unequal
rectangles packed together, which is what the page draws. It is one picture
of the whole workspace, and it is read-only: nothing on it changes anything, and there is
no live-sync poll behind it.

It fills the window. The header and the tag panel are drawn over the picture rather than
beside it, so the rectangles get the whole of the page rather than what is left after the
furniture — a treemap laid into a smaller box is the same map with every rectangle scaled
down, and the small ones lose their labels first. The page itself does not scroll: the map
is moved by dragging it.

Every project is a rectangle, and the bundles inside it are rectangles of their own. A
rectangle's **area is its card count** — a bundle holding two hundred cards is drawn a
hundred times the size of one holding two, and a project's size is the cards its bundles
hold between them. A bundle holding nothing has no area to be given, so empty bundles are
drawn as dashed outlines in a strip along the bottom of their project rather than left out.
A project with no cards at all is drawn the same way, in a strip along the foot of the map
— named, as an outline, and without its own bundles drawn inside it, since a project holding
no cards holds none in any of them. Bundles keep the colours their own board gives them.

Below the rectangles is a row of circles, one per scope, each with a line to every bundle
it reaches. A scope is drawn this way rather than as a rectangle of its own because a scope
is not inside a project — the same scope holds cards from several bundles and often from
several projects, which is exactly what the lines show. A scope reaching a project only
through a taskspace has no bundle to point at, so its line runs to the project instead.
Hover a circle to raise its own lines out of the rest.

The map opens centred, with room around it, and the control in the corner calls that 100% —
100% is the size the map opens at rather than the size that would fill the window, because
the view you were looking at a moment ago is the one worth measuring against. Filling the
window is 200%, and the range runs from 50% to 400%.

Drag anywhere on the map to move it, and hold `Ctrl` or `Cmd` while scrolling to zoom
toward the pointer — the same two gestures as the canvas, and the same `ui.zoomStep` behind
them. The control in the bottom-right corner zooms in steps, and the reading beside it is
also the way back: click the percentage to return to the size the map opened at. A drag that
starts on a bundle pans the map rather than opening that bundle's board, so there is no part
of the map you have to avoid grabbing.

Zooming in enlarges the rectangles and leaves the labels the size they were, so it does what
you would want it for: a bundle too small to be named where the map opens becomes large
enough to carry its name. The gaps between rectangles and the band each project's name sits
in stay put too — only the part that stands for cards grows.

The tags are on the left, as a tree over the map: `'perf` with `'perf:cache` beneath it,
the way a directory holds a subdirectory. The number beside each is how many cards it
gathers, that tag and everything under it. A tree taller than the window scrolls inside its
own panel, and the lines follow their rows as it does. Click a tag to draw a line from its
row to every bundle holding a card that carries it, and the rest of the map stands back so
the lines read. The lines stay until you clear them, and clicking the selected tag again is
how: pointing at a row does nothing, so a pointer crossing the panel on its way somewhere
else leaves the drawing alone. A click also puts `?tag=` in the URL, so any view of the map
is a link you can send.

Unlike the tag index, the map counts cards only — it reads no taskspace files. A file tag
has no bundle rectangle to be drawn against, and gathering one would put a number in the
tree that means something different from the number beside it.

The row of project names in the top right narrows the map to one project, the same control
the tag index carries and with the same `?projectId=` behind it. Narrowed, the map draws
that project's rectangle alone, and only the scopes and tags that reach it.

The activity grid at the bottom centre shows its UTC date range above a trailing year of
card changes. A new card counts as its first change; moving, resizing, or otherwise arranging
a card does not. Darker squares are busier UTC days. Click a square to size the treemap from
the cards changed on that day and filter the tag tree, its counts, and its bundle links to
those same cards; the heading then shows that specific date. Click the selected square again
or choose **Clear** to restore total card and tag counts and the full range heading. The
selection is stored as `?day=YYYY-MM-DD` and keeps any project or tag selection already in
the URL.

The server keeps the map's workspace-wide bundle counts, daily activity, scope graph, and
card-tag dimensions together in `.kozane/treemap.json`. The file is a disposable cache tied
to the database signature: any database change rebuilds the whole semantic snapshot, while
project and day selections are derived from it without caching viewport-dependent geometry.

A static export made with `kozane net ssg generate` carries the map, and both the tag
selection and the project narrowing keep working there without a server. The scope circles
are left out unless the export was built with `--include-scoped-files` — a plain export
carries no scopes anywhere, and the map holds the same line.

## Getting between the pages

The links between the three workspace-wide pages are icons rather than words, and each one
draws the thing its page is about: an even grid of four squares for the list of projects, no
one of them the large one; unequal rectangles packed together for the map, which is a
treemap; and a tree branching into two children for the tag index, which is what a tag
namespace is. They sit in the corner of each page's header, and each one names itself on
hover — which is also what a screen reader reads, since the picture says nothing on its own.

The connections in that last one are drawn rather than implied, and that is what makes it a
tree instead of an indented list. Rows on their own say "a list", which is what the project
page already is — two icons that look different while meaning much the same thing have to be
remembered rather than recognised.

The back link on the map and the tag index is the grid. Unnarrowed it leads to the project
list and stands alone; narrowed to a project it leads to that project's board, and the
project's name is drawn beside it. The icon is the same drawing either way, so the name is
what says which of the two you are about to get.

The row of project names on those pages stays in words. It is a set of choices to read
rather than a way out, and project names are not pictures.

## Card footers

Toggle footers with the `f` key. A footer shows, when relevant, the glue-group
link icon, the `taskspace` badge, and the card's bundle dot and name.

## Live sync

The project view polls the server about once a second, and again whenever the tab
regains focus, to pull in changes made by the CLI or another browser tab. Updates
apply without disturbing your current filter or selection. Live sync is off in a
static export, which is a fixed snapshot with no server behind it.
</content>
