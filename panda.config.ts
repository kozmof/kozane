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
            content: { value: "#575757" },
            secondary: { value: "#5a5650" },
            white: { value: "#ffffff" },
          },
          warm: {
            border: { value: "#e6e1d8" },
            dim: { value: "#cccccc" },
            muted: { value: "#b0aaa2" },
            subtle: { value: "#9e9890" },
            bg: { value: "#ede9e1" },
            faded: { value: "#b8b2a8" },
            placeholder: { value: "#b4b4b4" },
            icon: { value: "#cdc8be" },
            iconDim: { value: "#9a9490" },
            card: { value: "#dbdbdb" },
            grid: { value: "#dedad4" },
            scroll: { value: "#a8a8a8" },
            disabled: { value: "#e0dbd3" },
            secondary: { value: "#918c83" },
          },
          select: {
            bg: { value: "oklch(93% 0.055 272)" },
            surface: { value: "oklch(97% 0.025 272)" },
            accent: { value: "oklch(62% 0.15 272)" },
            text: { value: "oklch(38% 0.15 272)" },
            dim: { value: "oklch(55% 0.15 272)" },
          },
          wc: {
            bg: { value: "oklch(93% 0.055 158)" },
            text: { value: "oklch(48% 0.15 158)" },
          },
          state: {
            error: { value: "oklch(30% 0.18 18)" },
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
