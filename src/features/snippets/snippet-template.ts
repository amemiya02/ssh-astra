interface Variable {
  name: string;
  defaultValue?: string;
}

type Expansion = { text: string } | { missing: string[] };

/** Parse once so the prompt and expansion agree on variable order and defaults. */
export function parseSnippet(command: string) {
  const parts: (string | { variable: string })[] = [];
  const defaults = new Map<string, string | undefined>();
  // Shell syntax outside the Snippet grammar stays literal. A backslash can also
  // escape a placeholder, or escape a closing brace inside a default.
  const placeholder = /(\\*)\$\{([\p{L}_][\p{L}\p{M}\p{N}_]*)(?::((?:\\[}\\]|[^\\}]|\\(?![}\\]))*))?\}/gu;
  let end = 0;
  for (const match of command.matchAll(placeholder)) {
    const [literal, slashes = "", name = "", fallback] = match;
    parts.push(command.slice(end, match.index));
    end = match.index + literal.length;
    if (slashes.length % 2 === 1) {
      parts.push(literal.slice(1));
      continue;
    }
    parts.push(slashes, { variable: name });
    if (defaults.get(name) === undefined) defaults.set(name, fallback?.replace(/\\([}\\])/g, "$1"));
  }
  parts.push(command.slice(end));

  const variables: Variable[] = [...defaults].map(([name, defaultValue]) =>
    defaultValue === undefined ? { name } : { name, defaultValue },
  );
  return {
    variables,
    expand(values: ReadonlyMap<string, string>): Expansion {
      const missing = variables.filter(({ name, defaultValue }) =>
        defaultValue === undefined && !values.get(name),
      ).map(({ name }) => name);
      if (missing.length > 0) return { missing };
      return {
        text: parts.map((part) => typeof part === "string" ? part : values.get(part.variable) ?? defaults.get(part.variable) ?? "").join(""),
      };
    },
  };
}
