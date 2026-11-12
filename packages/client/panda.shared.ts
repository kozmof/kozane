import { defineConfig } from "@pandacss/dev";

export default defineConfig({
  preflight: false,
  importMap: {
    css: ["styled-system/css", "styles/css.js"],
    tokens: ["styled-system/tokens", "styles/tokens.js"],
  },
  theme: {
    extend: {
      tokens: {
        colors: {
          ink: {
            black: { value: "#1c1c1c" },
            // Use a filled state between black and content so the focused scope row stays
            // lighter than the board.
            charcoal: { value: "#222222" },
            light: { value: "#f1f1f1" },
            lighter: { value: "#f2f2f2" },
            canvas: { value: "#ececec" },
            content: { value: "#575757" },
            tag: { value: "#6e6e6e" },
            secondary: { value: "#575757" },
            white: { value: "#ffffff" },
          },
          neutral: {
            border: { value: "#e6e6e6" },
            dim: { value: "#cccccc" },
            muted: { value: "#5a5a5a" },
            subtle: { value: "#646464" },
            bg: { value: "#e7e7e7" },
            faded: { value: "#b4b4b4" },
            placeholder: { value: "#b4b4b4" },
            icon: { value: "#c9c9c9" },
            iconDim: { value: "#8d8d8d" },
            card: { value: "#e0e0e0" },
            grid: { value: "#dcdcdc" },
            scroll: { value: "#a8a8a8" },
            disabled: { value: "#dfdfdf" },
            secondary: { value: "#979797" },
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
            // Keep the error signal visible against `ink.black`, where the darker `error`
            // color disappears.
            errorBright: { value: "oklch(70% 0.17 18)" },
          },
        },
        fonts: {
          sans: { value: 'system-ui, sans-serif' },
          mono: { value: 'monospace' },
        },
      },
    },
  },
});
