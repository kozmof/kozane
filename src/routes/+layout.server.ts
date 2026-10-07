import { isSsgBuild } from "$lib/server/ssg";

// Use directory-style URLs for static exports so hosts resolve pages without extensionless
// HTML rules. Node builds keep the default trailing-slash policy.
export const trailingSlash = isSsgBuild() ? "always" : "never";
