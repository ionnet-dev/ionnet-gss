/**
 * Regular expressions written in game.yml (`pattern`, `include`). The schema calls them RE2; the panel runs them with
 * JavaScript's backtracking engine, so constructs RE2 doesn't have (look-around, back references) are refused: a
 * definition can't rely on behaviour another implementation would answer differently.  
 * A tenant chooses the matched value, so patterns that can backtrack catastrophically are refused too: a repeated group
 * that contains a quantifier or `|` (`(a+)*`, `(a|ab)+`, exponential) and more than `MAX_UNBOUNDED` unbounded
 * quantifiers (`a*a*a*a*`, polynomial). Patterns are capped at `MAX_LENGTH` characters and values at `MAX_VALUE`, and
 * the value length is checked before any match.
 */
export namespace Patterns {
  export const MAX_LENGTH = 200;

  /**
   * Longest value a pattern is run against. Longer values don't match.
   */
  export const MAX_VALUE = 1024;

  /**
   * Most unbounded quantifiers (`*`, `+`, `{n,}`, or `{n,m}` with m > `MAX_BOUNDED_REPEAT`) in one pattern.
   */
  export const MAX_UNBOUNDED = 3;

  /**
   * A `{n,m}` repeat up to this count counts as bounded.
   */
  const MAX_BOUNDED_REPEAT = 64;

  const compiled = new Map<string, RegExp>();

  /**
   * The error to show for a pattern the panel can't accept, or null when it is fine.
   */
  export function problem(pattern: string): string | null {
    if (pattern.length === 0 || pattern.length > MAX_LENGTH) return `must be 1-${MAX_LENGTH} characters long.`;
    if (/\(\?[=!<]|\\[1-9]|\\k</.test(pattern)) return "can't use look-around or back references (RE2 has none).";
    try {
      new RegExp(pattern, "u");
    } catch (error) {
      return `isn't a valid regular expression (${(error as Error).message.replace(/^Invalid regular expression: /, "")}).`;
    }
    return backtrackingProblem(pattern);
  }

  interface Frame {
    /** The group (or the pattern) contains a quantifier, also in nested groups. */
    quantified: boolean;
    /** The group contains `|`, also in nested groups. */
    alternation: boolean;
  }

  /**
   * Refuse shapes that make a backtracking engine take exponential or high-polynomial time. `pattern` is already a
   * valid `u` regular expression, so `{` always starts a quantifier and classes don't nest.
   */
  function backtrackingProblem(pattern: string): string | null {
    const stack: Frame[] = [{ quantified: false, alternation: false }];
    let unbounded = 0;
    let i = 0;
    // Reads a quantifier at `i`, if there is one: [repeats more than once, unbounded].
    const quantifier = (): [boolean, boolean] | null => {
      const char = pattern[i];
      let result: [boolean, boolean] | null = null;
      if (char === "*" || char === "+") {
        i++;
        result = [true, true];
      }
      else if (char === "?") {
        i++;
        result = [false, false];
      }
      else if (char === "{") {
        const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
        if (!match) return null;
        i += match[0].length;
        const min = Number(match[1]);
        const max = match[2] === undefined ? min : match[3] === "" ? Infinity : Number(match[3]);
        result = [max > 1, max > MAX_BOUNDED_REPEAT];
      }
      if (result && pattern[i] === "?") i++; // Lazy
      if (result?.[1]) unbounded++;
      return result;
    };
    while (i < pattern.length) {
      const char = pattern[i];
      const frame = stack[stack.length - 1];
      if (char === "\\") { // Escape, incl. \u{…} and \p{…}
        i += /^[upP]\{/.test(pattern.slice(i + 1, i + 3)) ? pattern.indexOf("}", i) + 1 - i : 2;
      }
      else if (char === "[") { // Class: up to the first unescaped ]
        i++;
        if (pattern[i] === "^") i++;
        if (pattern[i] === "]") i++;
        while (i < pattern.length && pattern[i] !== "]") i += pattern[i] === "\\" ? 2 : 1;
        i++;
      }
      else if (char === "(") {
        i += pattern.startsWith("(?:", i) ? 3 : 1;
        stack.push({ quantified: false, alternation: false });
        continue;
      }
      else if (char === ")") {
        i++;
        const group = stack.pop()!;
        const parent = stack[stack.length - 1];
        const found = quantifier();
        if (found?.[0] && (group.quantified || group.alternation)) {
          return "repeats a group that contains a quantifier or | (like (a+)* or (a|ab)+), which can take exponential time on a crafted value. Use a character class or a single quantifier instead.";
        }
        parent.quantified ||= group.quantified || found !== null;
        parent.alternation ||= group.alternation;
        continue;
      }
      else if (char === "|") {
        frame.alternation = true;
        i++;
        continue;
      }
      else {
        i++;
      }
      // An atom just ended: a quantifier may follow.
      if (quantifier()) frame.quantified = true;
      if (unbounded > MAX_UNBOUNDED) {
        return `has more than ${MAX_UNBOUNDED} unbounded quantifiers (*, + or {n,}), which can take very long on a crafted value.`;
      }
    }
    if (unbounded > MAX_UNBOUNDED) {
      return `has more than ${MAX_UNBOUNDED} unbounded quantifiers (*, + or {n,}), which can take very long on a crafted value.`;
    }
    return null;
  }

  /**
   * Whether the whole `value` matches `pattern` (anchored at both ends). A value over `MAX_VALUE` characters never
   * matches.
   * @throws Error for a pattern `problem()` refuses.
   */
  export function matchesWhole(pattern: string, value: string): boolean {
    if (value.length > MAX_VALUE) return false;
    let regex = compiled.get(`^${pattern}`);
    if (!regex) {
      const found = problem(pattern);
      if (found) throw new Error(`The pattern "${pattern}" ${found}`);
      regex = new RegExp(`^(?:${pattern})$`, "u");
      compiled.set(`^${pattern}`, regex);
    }
    return regex.test(value);
  }

  /**
   * Whether `pattern` matches anywhere in `value` (for `include`). A value over `MAX_VALUE` characters never matches.
   * @throws Error for a pattern `problem()` refuses.
   */
  export function matchesAnywhere(pattern: string, value: string): boolean {
    if (value.length > MAX_VALUE) return false;
    let regex = compiled.get(`~${pattern}`);
    if (!regex) {
      const found = problem(pattern);
      if (found) throw new Error(`The pattern "${pattern}" ${found}`);
      regex = new RegExp(pattern, "u");
      compiled.set(`~${pattern}`, regex);
    }
    return regex.test(value);
  }
}

export default Patterns;
