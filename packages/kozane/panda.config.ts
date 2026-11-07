import shared from "../../panda.config";
import { defineConfig } from "@pandacss/dev";
export default defineConfig({
  ...shared,
  include: ["./src/**/*.{js,ts,svelte}", "../client/src/**/*.{js,ts,svelte}"],
  outdir: "styled-system",
});
