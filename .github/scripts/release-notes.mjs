import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitTest(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.status === 0;
}

export function nightlyNotes(version, cwd = process.cwd()) {
  const current = git(["rev-parse", "HEAD"], cwd);
  const previous = gitTest(["show-ref", "--verify", "--quiet", "refs/tags/nightly"], cwd)
    ? git(["rev-parse", "refs/tags/nightly^{commit}"], cwd) : null;
  const comparable = previous && gitTest(["merge-base", "--is-ancestor", previous, current], cwd);
  const range = comparable ? [`${previous}..${current}`] : ["-1", current];
  const log = git(["log", "--format=%h%x09%s", ...range, "--"], cwd);
  const changes = log ? log.split("\n").map((line) => {
    const [sha, ...subject] = line.split("\t");
    const text = subject.join("\t").replace(/[\\`*_[\]<>]/g, "\\$&");
    return `- ${text} (\`${sha}\`)`;
  }).join("\n") : "No new commits since the previous nightly.";
  const baseline = comparable ? "Changes since the previous nightly:" :
    previous ? "The previous nightly is not an ancestor of this build. Only the current commit is listed:" :
      "No previous nightly comparison is available. Only the current commit is listed:";
  return `## Nightly ${version}\n\n${baseline}\n\n${changes}\n\nBuild: \`${current}\`.\n`;
}

export function releaseBody(release) {
  if (typeof release.body !== "string" || !release.body.trim()) {
    throw new Error("Release notes are missing or empty");
  }
  // tauri-action reads releaseBody through core.getInput(), which trims its input.
  return release.body.trim();
}

export function verifyManifest(manifest, release) {
  if (manifest.notes !== releaseBody(release)) {
    throw new Error("Updater manifest notes do not match the release body");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, first, second] = process.argv.slice(2);
  if (command === "nightly" && first && second) {
    writeFileSync(second, nightlyNotes(first));
  } else if (command === "output" && first && process.env.GITHUB_OUTPUT) {
    const body = releaseBody(JSON.parse(readFileSync(first, "utf8")));
    const delimiter = randomUUID();
    appendFileSync(process.env.GITHUB_OUTPUT, `body<<${delimiter}\n${body}\n${delimiter}\n`);
  } else if (command === "verify" && first && second) {
    verifyManifest(JSON.parse(readFileSync(first, "utf8")), JSON.parse(readFileSync(second, "utf8")));
  } else {
    throw new Error("Expected nightly <version> <file>, output <release.json>, or verify <manifest.json> <release.json>");
  }
}
