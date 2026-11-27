import type { FileEntry } from "@/lib/ipc/files";
import { quoteDroppedPaths } from "./dropped-paths";
import { isPlainCommandText } from "./history-suggestion";

interface Argument {
  path?: string;
  optional?: boolean;
  variadic?: boolean;
}

interface Option {
  names: readonly string[];
  args?: readonly Argument[];
  persistent?: boolean;
  equals?: boolean;
}

interface Command {
  names: readonly string[];
  args?: readonly Argument[];
  options?: readonly Option[];
  subcommands?: readonly Command[];
}

export interface CompletionCandidate {
  label: string;
  insert: string;
}

interface PathQuery {
  directory: string;
  directoriesOnly: boolean;
  prefix: string;
  typedDirectory: string;
  closeQuote: Quote;
}

export interface CompletionPlan {
  candidates: CompletionCandidate[];
  paths?: PathQuery;
  missingDirectory?: boolean;
}

type Quote = "" | "'" | '"';
type Word = { value: string; quote: Quote; tilde: boolean };

export const completionLimit = 40;
const filename = /^[^/\p{C}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]+$/u;
const ordinaryPath = /^[A-Za-z0-9_./-]+$/;

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A simple Bourne shell command. Decline substitutions, operators, globs and incomplete escapes. */
function readWords(line: string): { previous: Word[]; current: Word } | undefined {
  if (!isPlainCommandText(line)) return;
  const previous: Word[] = [];
  const empty = (): Word => ({ value: "", quote: "", tilde: false });
  let current = empty();
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === current.quote) {
      current.quote = "";
    } else if (char === "\\" && current.quote !== "'") {
      const next = line[++i];
      if (next === undefined) return;
      if (current.quote === '"' && !['$', '`', '"', "\\"].includes(next)) current.value += "\\";
      current.value += next;
    } else if (current.quote === "'") {
      current.value += char;
    } else if (current.quote === '"') {
      if (/[$`!]/.test(char)) return;
      current.value += char;
    } else if (char === "'" || char === '"') {
      current.quote = char;
    } else if (char === " ") {
      if (started) previous.push(current);
      current = empty();
      started = false;
      continue;
    } else {
      if (/[;&|<>(){}$`!*?[\]#]/.test(char) || (char === "=" && !started)) return;
      if (char === "~" && !started) {
        if (line[i + 1] !== "/") return;
        current.tilde = true;
      }
      current.value += char;
    }
    started = true;
  }
  return { previous, current };
}

function names(entries: readonly (Command | Option)[], current: Word): CompletionCandidate[] {
  const candidates = new Map<string, CompletionCandidate>();
  for (const entry of entries) {
    for (const name of entry.names) {
      if (!name.startsWith(current.value)) continue;
      const separator = "equals" in entry && entry.equals ? "=" : " ";
      candidates.set(name, { label: name, insert: name.slice(current.value.length) + current.quote + separator });
    }
  }
  return [...candidates.values()].sort((a, b) => compare(a.label, b.label)).slice(0, completionLimit);
}

function planPath(current: Word, argument: Argument | undefined, cwd: string | undefined, candidates: CompletionCandidate[] = []): CompletionPlan {
  if (!argument?.path) return { candidates };
  // Tilde expansion only applies to an unquoted leading tilde. Named-user homes
  // and bare tilde expand according to the shell, so they are left to the shell.
  if (current.tilde && !current.value.startsWith("~/")) return { candidates };
  if (!cwd?.startsWith("/") || /[\p{Cc}\p{Cs}]/u.test(cwd)) return { candidates, missingDirectory: true };
  const boundary = current.value.lastIndexOf("/") + 1;
  const typedDirectory = current.value.slice(0, boundary);
  const directory = current.value.startsWith("/") || current.tilde
    ? typedDirectory
    : cwd.endsWith("/") ? cwd + typedDirectory : cwd + "/" + typedDirectory;
  return {
    candidates,
    paths: {
      directory,
      directoriesOnly: argument.path === "directory",
      prefix: current.value.slice(boundary),
      typedDirectory,
      closeQuote: current.quote,
    },
  };
}

/** Computes static candidates and the one directory needed for a path argument. */
export function planCompletion(catalog: readonly Command[], line: string, cwd?: string): CompletionPlan {
  const words = readWords(line);
  if (!words) return { candidates: [] };
  const { previous, current } = words;
  const command = previous.shift();
  if (!command) return { candidates: names(catalog, current) };
  const root = catalog.find((entry) => entry.names.includes(command.value));
  if (!root) return { candidates: [] };
  let node: Command = root;
  let options = node.options ?? [];
  let endOptions = false;
  let optionArgs: readonly Argument[] = [];
  let positional = 0;

  for (const { value } of previous) {
    const argument = optionArgs[0];
    if (argument && !(!endOptions && value.startsWith("-") && (argument.optional || argument.variadic))) {
      if (!argument.variadic) optionArgs = optionArgs.slice(1);
      continue;
    }
    optionArgs = [];
    if (!endOptions && value === "--") {
      endOptions = true;
      continue;
    }
    if (!endOptions && value.startsWith("-") && value !== "-") {
      const flag = value.split("=", 1)[0];
      const option = options.find(({ names }) => names.some((name) => name === flag));
      // An unknown flag can take a value and shift every subsequent argument.
      if (!option) return { candidates: [] };
      optionArgs = option.args ?? [];
      if (value.includes("=") && !optionArgs[0]?.variadic) optionArgs = optionArgs.slice(1);
      continue;
    }
    const child: Command | undefined = !endOptions && positional === 0
      ? node.subcommands?.find((entry) => entry.names.includes(value))
      : undefined;
    if (child) {
      options = [...child.options ?? [], ...options.filter((option) => option.persistent)];
      node = child;
    } else if (!node.args?.[positional]?.variadic) {
      positional++;
    }
  }

  const argument = optionArgs[0];
  const mayStartOption = !endOptions && (!argument || argument.optional || argument.variadic);
  if (mayStartOption && current.value.startsWith("-")) {
    const separator = current.value.indexOf("=");
    if (separator < 0) return { candidates: names(options, current) };
    const key = current.value.slice(0, separator);
    const option = options.find(({ names }) => names.includes(key));
    return planPath({ ...current, value: current.value.slice(separator + 1), tilde: false }, option?.args?.[0], cwd);
  }
  if (argument) return planPath(current, argument, cwd);
  const candidates = positional === 0 && !endOptions ? names(node.subcommands ?? [], current) : [];
  const plan = planPath(current, node.args?.[positional], cwd, candidates);
  return !endOptions && !current.value && candidates.length === 0 && !plan.paths && !plan.missingDirectory
    ? { candidates: names(options, current) }
    : plan;
}

/** Directory results are untrusted. Only a literal, visible basename can reach the terminal. */
export function completePaths(query: PathQuery, entries: readonly Pick<FileEntry, "name" | "kind" | "linkTarget">[]): CompletionCandidate[] {
  const candidates = new Map<string, CompletionCandidate>();
  for (const { name, kind, linkTarget } of entries) {
    if (!filename.test(name) || name === "." || name === ".." || !name.startsWith(query.prefix) ||
      (name.startsWith(".") && !query.prefix.startsWith("."))) continue;
    const directory = kind === "dir" || linkTarget === "dir";
    if (query.directoriesOnly && !directory) continue;
    // At the start of a word, a leading dash could be read as an option.
    if (!query.typedDirectory && query.prefix.startsWith("-")) continue;
    const dotSlash = !query.typedDirectory && name.startsWith("-") ? "./" : "";
    const suffix = dotSlash + name.slice(query.prefix.length);
    const literal = literalSuffix(suffix, query.closeQuote);
    if (literal === null) continue;
    const label = query.typedDirectory + dotSlash + name + (directory ? "/" : "");
    const insert = literal + (directory ? "/" : " ");
    candidates.set(label, { label, insert });
  }
  return [...candidates.values()].sort((a, b) => compare(a.label, b.label)).slice(0, completionLimit);
}

function literalSuffix(suffix: string, quote: Quote): string | null {
  if (!suffix) return quote;
  if (quote !== "'" && ordinaryPath.test(suffix)) return quote + suffix;
  const escaped = quoteDroppedPaths("sh", [suffix]);
  if (escaped === null) return null;
  return quote === "'" ? escaped.slice(1) : quote + escaped;
}
