---
"@kozane/client": minor
"kozane": minor
---

Route taskspace label renames through a dedicated endpoint that preserves local
directory paths, marker files and observations. Permit label changes while a file
is open in the editor. The existing taskspace PATCH endpoint keeps its combined
label and directory behavior for earlier clients.

The updated HTTP client requires the label endpoint and does not fall back to the
directory-moving endpoint on older servers. Rename response fields remain unchanged.
