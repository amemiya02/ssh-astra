import { expect, it } from "vitest";
import { parseSnippet } from "./snippet-template";

it("uses one value per variable, taking the first declared default", () => {
  const template = parseSnippet("echo ${路径} ${路径:/srv:a} ${路径:/ignored} ${file}");
  expect(template.variables).toEqual([{ name: "路径", defaultValue: "/srv:a" }, { name: "file" }]);
  expect(template.expand(new Map([["file", "${路径}"]]))).toEqual({ text: "echo /srv:a /srv:a /srv:a ${路径}" });
  expect(template.expand(new Map([["路径", "/work"], ["file", "report"]]))).toEqual({ text: "echo /work /work /work report" });
});

it("leaves escaped placeholders and shell syntax literal and keeps default punctuation", () => {
  const command = "printf '%s\\n' \\${HOME} ${#HOME} ${suffix:a\\}b\\\\c\\d}";
  const template = parseSnippet(command);
  expect(template.variables).toEqual([{ name: "suffix", defaultValue: String.raw`a}b\c\d` }]);
  expect(template.expand(new Map())).toEqual({ text: "printf '%s\\n' ${HOME} ${#HOME} a}b\\c\\d" });
});

it("reports unfilled required variables in order while accepting an empty default", () => {
  const template = parseSnippet("${first} ${empty:} ${second} ${first}");
  expect(template.expand(new Map([["second", ""]]))).toEqual({ missing: ["first", "second"] });
  expect(template.expand(new Map([["first", "x"], ["second", " y "]]))).toEqual({ text: "x   y  x" });
});
