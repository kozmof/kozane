// Static export (kozane ssg): use directory-style URLs (foo/index.html) so every
// static host — GitHub Pages included — resolves project pages unambiguously,
// without depending on extensionless ".html" mapping or a foo.html/foo-directory
// split. The Node adapter keeps the default "never".
export const trailingSlash = process.env.KOZANE_SSG === "1" ? "always" : "never";
