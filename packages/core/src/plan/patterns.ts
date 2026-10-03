// Strip patterns (DESIGN.md "Configuration": `strip.extra`, `strip.keep`, `strip.never`) use gitignore syntax,
// relative to the project root. The subset here: a pattern with no slash but a trailing one matches a name at any
// depth; any other slash anchors it to the project folder; a trailing slash matches folders only; `**` spans
// folders, `*` and `?` stay inside one name, `[...]` is a character class. Blank lines and `#` comments match
// nothing, and so does a negation (`!`), which strip lists have no use for.

export interface PatternSet {
  /** Whether a pattern matches this entry itself. */
  matches(path: string, kind: "file" | "dir" | "symlink"): boolean;
  /** Whether a pattern matches the path (as a file or a folder) or any folder above it. */
  covers(path: string): boolean;
}

interface Compiled {
  regex: RegExp;
  dirOnly: boolean;
}

const globToRegex = (glob: string): string => {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        const atStart = i === 0 || glob[i - 1] === "/";
        if (atStart && slashAfter) {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) out += "\\[";
      else {
        const body = glob
          .slice(i + 1, end)
          .replace(/^!/, "^")
          .replaceAll("\\", "\\\\");
        out += `[${body}]`;
        i = end;
      }
    } else out += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return out;
};

const compile = (pattern: string): Compiled | undefined => {
  let text = pattern.trim();
  if (text === "" || text.startsWith("#") || text.startsWith("!")) return undefined;
  const dirOnly = text.endsWith("/");
  if (dirOnly) text = text.replace(/\/+$/, "");
  const anchored = text.includes("/");
  text = text.replace(/^\/+/, "");
  if (text === "") return undefined;
  const body = globToRegex(text);
  return { regex: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`), dirOnly };
};

export const compilePatterns = (patterns: readonly string[]): PatternSet => {
  const compiled = patterns.map(compile).filter((c): c is Compiled => c !== undefined);
  const matches = (path: string, kind: "file" | "dir" | "symlink"): boolean =>
    compiled.some((c) => (!c.dirOnly || kind === "dir") && c.regex.test(path));
  return {
    matches,
    covers: (path) => {
      if (matches(path, "file") || matches(path, "dir")) return true;
      for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
        if (matches(path.slice(0, slash), "dir")) return true;
      }
      return false;
    },
  };
};
