import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { nightlyNotes, releaseBody, verifyManifest } from "./release-notes.mjs";

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), "jam-release-notes-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  const commit = (subject) => {
    git("commit", "--allow-empty", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  return { cwd, git, commit };
}

test("nightly notes list only changes after the previous nightly", (t) => {
  const { cwd, git, commit } = repository(t);
  commit("Old change");
  git("tag", "nightly");
  commit("Fix scanning");
  const current = commit("Improve [filters]");
  const notes = nightlyNotes("1.2.0-nightly.42", cwd);
  assert.match(notes, /Changes since the previous nightly/);
  assert.match(notes, /Fix scanning/);
  assert.ok(notes.includes("Improve \\[filters\\]"));
  assert.ok(notes.includes(current));
  assert.doesNotMatch(notes, /Old change/);
});

test("first nightly explicitly labels its limited baseline", (t) => {
  const { cwd, commit } = repository(t);
  commit("Old change");
  commit("Current summary");
  const notes = nightlyNotes("1.2.0-nightly.1", cwd);
  assert.match(notes, /No previous nightly comparison/);
  assert.match(notes, /Current summary/);
  assert.doesNotMatch(notes, /Old change/);
});

test("a rewritten history does not pretend to have a complete comparison", (t) => {
  const { cwd, git, commit } = repository(t);
  commit("Old history");
  git("tag", "nightly");
  git("checkout", "--orphan", "rewritten");
  commit("New history");
  assert.match(nightlyNotes("1.2.0-nightly.2", cwd), /not an ancestor/);
});

test("no changes is explicit and git failures are surfaced", (t) => {
  const { cwd, git, commit } = repository(t);
  commit("Existing nightly");
  git("tag", "nightly");
  assert.match(nightlyNotes("1.2.0-nightly.3", cwd), /No new commits/);
  const invalid = join(cwd, "not-a-directory");
  writeFileSync(invalid, "");
  assert.throws(() => nightlyNotes("1.2.0-nightly.4", invalid));
});

test("manifest verification checks exact release notes and rejects missing content", () => {
  const body = "## Changes\n\n- Fix scanning\n";
  assert.equal(releaseBody({ body }), body.trim());
  assert.doesNotThrow(() => verifyManifest({ notes: body.trim() }, { body }));
  assert.throws(() => verifyManifest({ notes: "" }, { body }), /do not match/);
  for (const body of [null, undefined, "", "  "]) {
    assert.throws(() => releaseBody({ body }), /missing or empty/);
  }
});

test("the workflow CLI carries multiline notes into the manifest input without shell interpolation", (t) => {
  const { cwd } = repository(t);
  const script = fileURLToPath(new URL("./release-notes.mjs", import.meta.url));
  const release = join(cwd, "release.json");
  const output = join(cwd, "output");
  const manifest = join(cwd, "latest.json");
  const body = "## Changes\n\n- Keep `code` and $variables literal\n\n[Details](https://example.invalid)\n";
  writeFileSync(release, JSON.stringify({ body }));
  execFileSync(process.execPath, [script, "output", release], {
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  const lines = readFileSync(output, "utf8").split("\n");
  const delimiter = lines[0].slice("body<<".length);
  assert.equal(lines.at(-2), delimiter);
  const input = lines.slice(1, -2).join("\n");
  assert.equal(input, body.trim());
  writeFileSync(manifest, JSON.stringify({ notes: input }));
  assert.doesNotThrow(() => execFileSync(process.execPath, [script, "verify", manifest, release]));
});
