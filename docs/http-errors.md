# HTTP error compatibility

Domain codes travel in `X-Kozane-Error-Code`. Error bodies retain the existing `{ message }` shape. Authentication, permission and throttling errors retain their transport statuses without a domain header.

| Operation or error                 | Status | Domain code | Message                                       |
| ---------------------------------- | ------ | ----------- | --------------------------------------------- |
| Invalid service input              | 400    | validation  | Existing validation message                   |
| Default layer or partition removal | 400    | validation  | Existing default-row message                  |
| Missing resource                   | 404    | not_found   | Resource-specific message or adapter override |
| Missing referenced row             | 404    | not_found   | Adapter override or referenced-record message |
| Duplicate layer create/rename      | 400    | conflict    | `A layer named "…" already exists`            |
| Duplicate partition create/rename  | 400    | conflict    | `A partition named "…" already exists`        |
| Duplicate scope create/rename      | 409    | conflict    | `A scope named "…" already exists`            |
| Other unique constraint            | 409    | conflict    | Existing unique-message override or default   |
| New service size limit             | 413    | limit       | Safe service message                          |
| Unavailable database               | 500    | unavailable | Safe service message                          |

Existing content and batch limits remain validation errors with status 400. Normalization does not change them to size-limit errors. Database classification metadata and diagnostic causes are never serialized into HTTP error bodies or headers.

The adapter sets headers through SvelteKit's request event and retains thrown HTTP errors. Unit tests verify header assignment and compatibility mappings.
