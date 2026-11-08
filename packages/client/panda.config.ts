import { defineConfig } from "@pandacss/dev";
import shared from "./panda.shared";
export default defineConfig({
  ...shared,
  include: ["packages/client/src/**/*.{js,ts,svelte}"],
  outdir: "packages/client/styled-system",
  outExtension: "js",
  exclude: ["**/styles/generated/**"],
});
