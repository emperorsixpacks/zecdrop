// Test helper: read user-facing strings straight out of the Rust sources, so
// the web copy can be compared with what the core really says. This is a
// drift alarm, not a Rust parser: it looks only at string literals between
// two markers, in order.

/** The text between `start` and `end` markers (first occurrence of each). */
export function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`marker not found in Rust source: ${start}`);
  const to = source.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`marker not found in Rust source: ${end}`);
  return source.slice(from + start.length, to);
}

/** Every "double quoted" string literal in `code`, in order, unescaped. */
export function stringLiterals(code: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(/"((?:[^"\\]|\\.)*)"/gu)) {
    found.push((match[1] ?? "").replace(/\\(["\\])/gu, "$1"));
  }
  return found;
}

/** Fill `{name}` placeholders the way Rust's format! would. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/gu, (_whole, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`no value for {${name}}`);
    return String(value);
  });
}
