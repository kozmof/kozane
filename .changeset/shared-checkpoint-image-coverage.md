---
"@kozane/core": minor
"kozane": minor
---

Check shared recovery manifests against baseline and full effect images while retaining extra invocation requirements. Add a Node workflow that validates both saved checkpoint payloads, commits their combined image protection before verification and preserves earlier protection after failed verification or commits. Recheck both catalog bindings and saved payloads under the image writer lock. Complete bundle publication and installation remain pending.
