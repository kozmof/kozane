import { isSsgBuild } from "$lib/server/ssg";

// Static export (kozane net ssg generate): use directory-style URLs (foo/index.html) so every
// static host — GitHub Pages included — resolves namespace pages unambiguously,
// without depending on extensionless ".html" mapping or a foo.html/foo-directory
// split. The Node adapter keeps the default "never".
export const trailingSlash = isSsgBuild() ? "always" : "never";
