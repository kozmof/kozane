import { defineConfig } from "@pandacss/dev";
import shared from "../../panda.config";
export default defineConfig({
  ...shared,
  include: ["packages/kozane/src/lib/**/*.{js,ts,svelte}", "packages/client/src/**/*.{js,ts,svelte}"],
  exclude: ["**/*.test.*", "**/*.fixtures.*"],
});
