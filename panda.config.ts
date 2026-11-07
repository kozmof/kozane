import { defineConfig } from "@pandacss/dev";
import shared from "./packages/client/panda.shared";
export default defineConfig({
  ...shared,
  include: [
    "./packages/kozane/src/**/*.{js,ts,svelte}",
    "./packages/client/src/**/*.{js,ts,svelte}",
  ],
  exclude: ["**/styles/generated/**"],
  outdir: "styled-system",
});
