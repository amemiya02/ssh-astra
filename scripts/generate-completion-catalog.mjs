import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const revision = "aef52acff84c45edde61ae610cc2c964802b9a38";
const sha256 = "44f11c63d150b2f77db35479871b026e0c9882e1049a29d201d0a8ab46c2aaab";
const archive = process.argv[2];
if (!archive) {
  throw new Error(`Pass a local archive from https://codeload.github.com/withfig/autocomplete/tar.gz/${revision}`);
}

const fingerprint = createHash("sha256").update(readFileSync(archive)).digest("hex");
if (fingerprint !== sha256) throw new Error("Fig archive does not match the pinned source");
const root = `autocomplete-${revision}`;
const commands = [
  "date", "brew", "cat", "cd", "crontab", "chmod", "chown", "cp", "curl", "cut", "df", "diff",
  "dig", "docker", "du", "echo", "find", "git", "grep", "go", "head", "nano", "jq",
  "kubectl", "less", "ln", "ls", "make", "man", "mkdir", "mv", "npm", "ping", "pip", "ps",
  "python", "rg", "rm", "rsync", "scp", "sed", "sort", "ssh", "systemctl", "tail", "tar",
  "touch", "uname", "uniq", "unzip", "wc", "wget", "xargs", "zip",
];

function read(path) {
  return execFileSync("tar", ["-xOf", archive, `${root}/${path}`], { encoding: "utf8" });
}

// Interpret only literals and references to top-level const declarations in the same file.
// No imports, function calls, getters, generators or property access on runtime objects.
function staticSpec(name) {
  const file = ts.createSourceFile(`${name}.ts`, read(`src/${name}.ts`), ts.ScriptTarget.Latest, true);
  const constants = new Map();
  let exported;
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) constants.set(decl.name.text, decl.initializer);
      }
    } else if (ts.isExportAssignment(statement)) {
      exported = statement.expression;
    }
  }

  const resolving = new Set();
  const cache = new Map();
  function value(node) {
    if (!node) return;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      return value(node.expression);
    }
    if (ts.isIdentifier(node)) return constant(node.text);
    if (ts.isPropertyAccessExpression(node)) return value(node.expression)?.[node.name.text];
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.flatMap((item) => {
        if (!ts.isSpreadElement(item)) return [value(item)];
        const spread = value(item.expression);
        return Array.isArray(spread) ? spread : [];
      });
    }
    if (ts.isObjectLiteralExpression(node)) {
      const result = Object.create(null);
      for (const prop of node.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const spread = value(prop.expression);
          if (spread && typeof spread === "object" && !Array.isArray(spread)) Object.assign(result, spread);
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          result[prop.name.text] = constant(prop.name.text);
        } else if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
          result[prop.name.text] = value(prop.initializer);
        }
      }
      return result;
    }
  }

  function constant(name) {
    if (cache.has(name)) return cache.get(name);
    if (resolving.has(name)) return;
    resolving.add(name);
    const resolved = value(constants.get(name));
    resolving.delete(name);
    cache.set(name, resolved);
    return resolved;
  }

  return value(exported);
}

function array(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function args(values) {
  return array(values).map((arg) => {
    const templates = [...array(arg?.template), ...array(arg?.generators).flatMap((generator) => array(generator?.template))];
    const path = templates.includes("filepaths") ? "file" : templates.includes("folders") ? "directory" : undefined;
    return { path, variadic: arg?.isVariadic === true || undefined, optional: arg?.isOptional === true || undefined };
  });
}

function project(spec, type = "command") {
  if (!spec || spec.hidden || spec.isHidden) return;
  const pattern = type === "option" ? /^--?[A-Za-z0-9][A-Za-z0-9_.-]*$/ : /^[A-Za-z0-9_][A-Za-z0-9_.:+-]*$/;
  const names = array(spec.name).filter((name) => typeof name === "string" && pattern.test(name));
  if (names.length === 0) return;
  const positional = args(spec.args);
  // Fig's cd uses a called generator. Map its directory parameter explicitly.
  if (names[0] === "cd" && !positional[0]?.path) positional[0] = { path: "directory" };
  const result = { names };
  if (positional.length > 0) result.args = positional;
  if (type === "option") {
    if (spec.isPersistent) result.persistent = true;
    if (spec.requiresSeparator === true || spec.requiresSeparator === "=" || spec.requiresEquals === true) result.equals = true;
  } else {
    const options = array(spec.options).map((option) => project(option, "option")).filter(Boolean);
    const subcommands = array(spec.subcommands).map((subcommand) => project(subcommand)).filter(Boolean);
    if (options.length > 0) result.options = options;
    if (subcommands.length > 0) result.subcommands = subcommands;
  }
  return result;
}

const catalog = commands.map((name) => {
  const spec = project(staticSpec(name));
  if (!spec) throw new Error(`Missing static spec for ${name}`);
  return { ...spec, names: [...new Set([name, ...spec.names])] };
});

const format = (command, depth) => {
  const { subcommands, ...node } = command;
  const indent = "  ".repeat(depth);
  const fields = JSON.stringify(node);
  return subcommands
    ? `${indent}${fields.slice(0, -1)},"subcommands":[\n${subcommands.map((child) => format(child, depth + 1)).join(",\n")}\n${indent}]}`
    : indent + fields;
};
writeFileSync(new URL("../src/features/terminal/completion-catalog.json", import.meta.url), `[\n${catalog.map((command) => format(command, 1)).join(",\n")}\n]\n`);
writeFileSync(new URL("../public/completion-catalog-notices.txt", import.meta.url),
  `SSH Astra command completion catalog\nSource: https://github.com/withfig/autocomplete/tree/${revision}\n\n${read("LICENSE")}`);
