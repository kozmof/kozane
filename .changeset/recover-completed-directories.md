---
"kozane": minor
---

Extend taskspace recovery to completed directory moves, layout changes and removals. Preview recorded actions and verify unchanged taskspace fields, attachment and disk evidence before explicitly committing database changes with confirmation. Preserve pending evidence after failures and refuse partial, stale or abandoned operations without repeating filesystem work.
