// Stub SvelteKit's `$app/navigation` module. Defaults do nothing. Tests can observe calls with
// `vi.spyOn(navigation, "goto")`.
export function goto(_url: string | URL): Promise<void> {
  return Promise.resolve();
}

export function replaceState(_url: string | URL, _state: Record<string, unknown>): void {}

/**
 * Provide a no-op navigation guard registration. Tests that need the callback can mock this
 * module to capture it.
 */
export function beforeNavigate(_callback: (navigation: unknown) => void): void {}
