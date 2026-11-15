/**
 * Minimal ANSI SGR handling for the console: the 16 standard colours, bold, dim, italic and underline become
 * attributes on text segments; every other escape sequence is dropped. The text is never treated as HTML.
 */

export interface AnsiSegment {
  text: string;
  fg: number | null; // 0-15; 8-15 are the bright variants.
  bg: number | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

interface Style {
  fg: number | null;
  bg: number | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

// CSI (with parameters, any final byte), OSC up to BEL or ST, any other two-byte escape, then stray control characters.
const ESCAPES = /\x1b\[([0-9;:?]*)([\x20-\x2f]*[\x40-\x7e])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[\x20-\x7e]?|[\x00-\x08\x0a-\x1f\x7f]/g;

function applyCodes(style: Style, params: string): void {
  const codes = params === "" ? [0] : params.split(/[;:]/).map((code) => code === "" ? 0 : Number(code));
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) Object.assign(style, { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false });
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 22) { style.bold = false; style.dim = false; }
    else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code >= 30 && code <= 37) style.fg = code - 30;
    else if (code >= 90 && code <= 97) style.fg = code - 90 + 8;
    else if (code >= 40 && code <= 47) style.bg = code - 40;
    else if (code >= 100 && code <= 107) style.bg = code - 100 + 8;
    else if (code === 39) style.fg = null;
    else if (code === 49) style.bg = null;
    else if (code === 38 || code === 48) {
      // 256-colour (`5;n`) maps its first 16 entries; truecolour and the rest keep the theme's colour so the log stays
      // readable in light and dark.
      const target = code === 38 ? "fg" : "bg";
      if (codes[i + 1] === 5) {
        const index = codes[i + 2];
        style[target] = index !== undefined && index >= 0 && index < 16 ? index : null;
        i += 2;
      }
      else if (codes[i + 1] === 2) {
        style[target] = null;
        i += 4;
      }
    }
  }
}

/**
 * Split one console line into styled segments. Always returns at least one segment.
 */
export function parseAnsi(line: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  const style: Style = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false };
  let last = 0;
  const push = (text: string) => {
    if (text !== "") segments.push({ ...style, text });
  };
  ESCAPES.lastIndex = 0;
  for (let match = ESCAPES.exec(line); match; match = ESCAPES.exec(line)) {
    push(line.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[2] === "m") applyCodes(style, match[1]);
  }
  push(line.slice(last));
  return segments.length > 0 ? segments : [{ ...style, text: "" }];
}
