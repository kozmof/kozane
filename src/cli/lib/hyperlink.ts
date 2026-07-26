// Wraps a URL in an OSC 8 terminal hyperlink escape sequence so supporting
// terminals render clickable text. Falls back to the plain label when output
// isn't a TTY or NO_COLOR is set, keeping piped and redirected output clean.
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
