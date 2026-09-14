import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs, runLintCli, UsageError, type CliIo } from "../src/cli-lib.js";

function io(files: Record<string, string> = {}, stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const api: CliIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    readFile: (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
    readStdin: () => stdin,
  };
  return { api, out: () => out.join(""), err: () => err.join("") };
}

const tools = JSON.stringify({
  tools: [
    {
      name: "search_products",
      description: "Search the product catalogue by keyword and return matches.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "Keyword" } } },
      outputSchema: null,
    },
    { name: "bad name!", description: "", inputSchema: null, outputSchema: null },
  ],
});

test("parseCliArgs validates options", () => {
  const a = parseCliArgs([
    "tools.json",
    "--fail-on",
    "warning",
    "--rule",
    "no-tools=off",
    "--rule",
    'too-many-tools={"max":3}',
    "--rule",
    "description-length=error",
  ]);
  assert.equal(a.file, "tools.json");
  assert.equal(a.failOn, "warning");
  assert.deepEqual(a.rules, { "no-tools": false, "too-many-tools": { max: 3 }, "description-length": "error" });
  assert.throws(() => parseCliArgs(["x", "--fail-on", "fatal"]), UsageError);
  assert.throws(() => parseCliArgs(["x", "--format", "xml"]), UsageError);
  assert.throws(() => parseCliArgs(["x", "--rule", "nope"]), UsageError);
  assert.throws(() => parseCliArgs(["x", "--rule", "a=maybe"]), UsageError);
  assert.throws(() => parseCliArgs(["x", "--bogus"]), UsageError);
});

test("lints a tools.json and exits 1 on errors", async () => {
  const t = io({ "tools.json": tools });
  assert.equal(await runLintCli(["tools.json"], t.api), 1);
  assert.match(t.out(), /tool-name-valid/);
  assert.match(t.out(), /error\(s\)/);
  assert.equal(t.err(), "");
});

test("--fail-on never and --rule off change the exit code", async () => {
  const t = io({ "tools.json": tools });
  assert.equal(await runLintCli(["tools.json", "--fail-on", "never"], t.api), 0);
  const u = io({ "tools.json": tools });
  assert.equal(await runLintCli(["tools.json", "--rule", "tool-name-valid=off", "--rule", "description-missing=off"], u.api), 0);
  const v = io({ "tools.json": tools });
  assert.equal(await runLintCli(["tools.json", "--rule", "tool-name-valid=off", "--rule", "description-missing=off", "--fail-on", "warning"], v.api), 1);
});

test("--format json prints the LintResult and reads stdin with -", async () => {
  const t = io(
    {},
    JSON.stringify([{ name: "ok_tool", description: "A perfectly fine description of what this tool does.", inputSchema: { type: "object", properties: {} } }]),
  );
  assert.equal(await runLintCli(["-", "--format", "json", "--url", "https://shop.test/"], t.api), 0);
  const parsed = JSON.parse(t.out());
  assert.equal(parsed.url, "https://shop.test/");
  assert.ok(Array.isArray(parsed.findings));
  assert.ok(parsed.rulesRun.includes("tool-name-valid"));
});

test("--format github prints one workflow command per finding", async () => {
  const t = io({ "tools.json": tools });
  assert.equal(await runLintCli(["tools.json", "--format", "github"], t.api), 1);
  const lines = t.out().trim().split("\n");
  assert.ok(
    lines.every((l) => /^::(error|warning|notice) file=tools\.json,title=webmcp-lint%3A [a-z-]+::/.test(l)),
    t.out(),
  );
  assert.ok(lines.some((l) => l.startsWith("::error file=tools.json,title=webmcp-lint%3A tool-name-valid::bad name!: ")));
});

test("reads a real file from disk and a fixture snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webmcp-lint-"));
  const file = join(dir, "snapshot.json");
  writeFileSync(
    file,
    JSON.stringify({
      url: "https://shop.test/",
      capturedAt: "",
      frames: [{ url: "https://shop.test/", origin: "https://shop.test", isTop: true, api: "shim" }],
      tools: [],
    }),
  );
  const t: CliIo = { stdout: () => {}, stderr: () => {}, readFile: (p) => readFileSync(p, "utf8"), readStdin: () => "" };
  assert.equal(await runLintCli([file, "--fail-on", "info"], t), 1);
  assert.equal(await runLintCli([file, "--fail-on", "info", "--scope", "tool"], t), 0);
});

test("usage errors exit 2 with help", async () => {
  const t = io();
  assert.equal(await runLintCli([], t.api), 2);
  assert.match(t.err(), /missing <file.json>/);
  assert.match(t.err(), /Usage: webmcp-lint/);
  const u = io({ "bad.json": "{not json" });
  assert.equal(await runLintCli(["bad.json"], u.api), 2);
  assert.match(u.err(), /could not read bad.json/);
  const v = io({ "shape.json": '{"foo":1}' });
  assert.equal(await runLintCli(["shape.json"], v.api), 2);
  assert.match(v.err(), /Expected a PageSnapshot/);
  const w = io();
  assert.equal(await runLintCli(["--help"], w.api), 0);
  assert.match(w.out(), /--fail-on/);
});
