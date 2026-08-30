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
            black: { value: "#1c1c1c" },
            // Between black and content: dark enough to read as a filled state, short of the
            // full-black weight that made the focused scope row heavier than the board.
            charcoal: { value: "#222222" },
            light: { value: "#f1f1f1" },
            lighter: { value: "#f2f2f2" },
            canvas: { value: "#ececec" },
            content: { value: "#575757" },
            secondary: { value: "#575757" },
            white: { value: "#ffffff" },
          },
          neutral: {
            border: { value: "#e6e6e6" },
            dim: { value: "#cccccc" },
            muted: { value: "#6d6d6d" },
            subtle: { value: "#646464" },
            bg: { value: "#e2e2e2" },
            faded: { value: "#b4b4b4" },
            placeholder: { value: "#b4b4b4" },
            icon: { value: "#c9c9c9" },
            iconDim: { value: "#8d8d8d" },
            card: { value: "#e2e2e2" },
            grid: { value: "#dcdcdc" },
            scroll: { value: "#a8a8a8" },
            disabled: { value: "#dfdfdf" },
            secondary: { value: "#8f8f8f" },
          },
          select: {
            bg: { value: "oklch(93% 0.055 272)" },
            surface: { value: "oklch(97% 0.025 272)" },
            accent: { value: "oklch(62% 0.15 272)" },
            text: { value: "oklch(38% 0.15 272)" },
            dim: { value: "oklch(55% 0.15 272)" },
          },
          taskspace: {
            bg: { value: "oklch(93% 0.055 158)" },
            text: { value: "oklch(48% 0.15 158)" },
          },
          state: {
            error: { value: "oklch(30% 0.18 18)" },
            // The same signal read against ink.black — the dark `error` vanishes there.
            errorBright: { value: "oklch(70% 0.17 18)" },
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
