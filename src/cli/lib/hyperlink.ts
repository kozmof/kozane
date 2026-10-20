// Render a clickable label with an OSC 8 hyperlink in supporting terminals.
// Use the plain label when output is not a TTY or NO_COLOR is enabled.
const OSC_8 = "]8;;";
const ST = "\\";

export interface HyperlinkOptions {
  isTTY?: boolean;
  noColor?: boolean;
}

export function hyperlink(url: string, label = url, options: HyperlinkOptions = {}): string {
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY);
  const noColor = options.noColor ?? Boolean(process.env.NO_COLOR);
  if (!isTTY || noColor) return label;
  return `${OSC_8}${url}${ST}${label}${OSC_8}${ST}`;
}
