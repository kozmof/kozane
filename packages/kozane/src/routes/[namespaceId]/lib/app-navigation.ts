import { beforeNavigate, goto, replaceState } from "$app/navigation";
import type { NavigationDriver } from "../../../../../client/src/navigation.js";
/** SvelteKit host bridge. Shared views depend only on NavigationDriver. */
export function createAppNavigationDriver(): NavigationDriver {
  return {
    beforeNavigate: (listener) => beforeNavigate(listener),
    navigate: (url) => goto(url),
    replace: (url) => replaceState(url, {}),
  };
}
