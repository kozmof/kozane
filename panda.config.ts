import { defineConfig } from "@pandacss/dev";

export default defineConfig({
  preflight: false,
  include: ["./src/**/*.{js,ts,svelte}"],
  exclude: [],
  theme: {
    extend: {
      tokens: {
        colors: {
          ink: {
            black: { value: "#1c1a17" },
            light: { value: "#f1f1f1" },
            lighter: { value: "#f2f2f2" },
          },
          warm: {
            border: { value: "#e6e1d8" },
            dim: { value: "#cccccc" },
            muted: { value: "#b0aaa2" },
            subtle: { value: "#9e9890" },
            bg: { value: "#ede9e1" },
          },
        },
        fonts: {
          sans: { value: '"IBM Plex Sans", system-ui, sans-serif' },
          mono: { value: '"IBM Plex Mono", monospace' },
        },
      },
    },
  },
  outdir: "styled-system",
});
