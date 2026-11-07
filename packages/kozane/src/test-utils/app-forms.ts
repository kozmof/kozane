// Stub SvelteKit's `$app/forms` module. `use:enhance` does nothing, so forms render without a
// SvelteKit runtime.
export function enhance(_form: HTMLFormElement, _submit?: unknown): { destroy(): void } {
  return { destroy() {} };
}
