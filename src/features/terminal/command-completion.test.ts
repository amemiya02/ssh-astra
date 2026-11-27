import { expect, it } from "vitest";
import catalog from "./completion-catalog.json";
import { completePaths, planCompletion } from "./command-completion";

it("completes command names and nested subcommands from the bundled catalog", () => {
  expect(planCompletion(catalog, "gi").candidates).toContainEqual({ label: "git", insert: "t " });
  expect(planCompletion(catalog, "git ch").candidates).toContainEqual({ label: "checkout", insert: "eckout " });
  expect(planCompletion(catalog, "docker image pu").candidates).toContainEqual({ label: "push", insert: "sh " });
});

it("completes options in context and stops suggesting them after --", () => {
  expect(planCompletion(catalog, "git checkout --tr").candidates).toContainEqual({ label: "--track", insert: "ack " });
  expect(planCompletion(catalog, "git checkout -- --tr").candidates).toEqual([]);
  expect(planCompletion(catalog, "curl ").candidates).toContainEqual({ label: "--abstract-unix-socket", insert: "--abstract-unix-socket " });
});

it("requests an explicit directory only for a path position", () => {
  expect(planCompletion(catalog, "grep pat", "/work").paths).toBeUndefined();
  expect(planCompletion(catalog, "grep pat '../a b/f", "/work").paths).toMatchObject({
    directory: "/work/../a b/", directoriesOnly: false, prefix: "f",
  });
  expect(planCompletion(catalog, "cd ~/do", "/work").paths).toMatchObject({
    directory: "~/", directoriesOnly: true, prefix: "do",
  });
  expect(planCompletion(catalog, "grep --file=/tmp/ab", "/work").paths).toMatchObject({
    directory: "/tmp/", prefix: "ab",
  });
  expect(planCompletion(catalog, "cat ", undefined)).toMatchObject({ missingDirectory: true });
  expect(planCompletion(catalog, "cat $(pwd)/", "/work").paths).toBeUndefined();
  expect(planCompletion(catalog, "echo ok; cat ", "/work").paths).toBeUndefined();
});

it("inserts only a literal suffix for a visible path", () => {
  const query = planCompletion(catalog, "cat 'we", "/work").paths!;
  const regular = (name: string) => ({ name, kind: "file" as const, linkTarget: null });
  expect(completePaths(query, [
    regular("we'ird; $HOME"),
    regular("we\u202eevil"),
    regular("we\nevil"),
    regular("we/escape"),
    regular(".well-hidden"),
    { name: "website", kind: "dir", linkTarget: null },
  ])).toEqual([
    { label: "we'ird; $HOME", insert: "'\\''ird; $HOME' " },
    { label: "website/", insert: "bsite'/" },
  ]);

  const cd = planCompletion(catalog, "cd ", "/work").paths!;
  expect(completePaths(cd, [regular("notes"), { name: "-dash", kind: "dir", linkTarget: null }]))
    .toEqual([{ label: "./-dash/", insert: "./-dash/" }]);
});
