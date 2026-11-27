---
"kozane": minor
---

Connect registered saved recovery manifests to image reservation and byte verification through the checkpoint-image workflow's assetMaxBytes option. Carry all three original catalog bindings and payload files through image writer boundaries, commit protection before image reads and preserve earlier protection after failed loading, verification or commits. Keep host-supplied manifests available as a separate input mode and refuse ambiguous inputs.
