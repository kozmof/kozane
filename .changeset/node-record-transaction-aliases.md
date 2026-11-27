---
"kozane": patch
---

Expose the existing core transaction helpers through Node record wrappers for stack-order reassignment, layer and partition removal, and namespace squashing. Keep wrapper exports aligned with the public core package.

Recognize the Node card upload adapters in the runtime graph check and verify that they delegate validation to the same public core error class before SQL access.

Verify distinct transaction handles while preserving the original database receiver for bound methods.
