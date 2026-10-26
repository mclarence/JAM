// Stamps the app version into tauri.conf.json, which Tauri uses for the bundle and the updater.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const confPath = fileURLToPath(
  new URL("../../src-tauri/tauri.conf.json", import.meta.url),
);

const version = process.argv[2];
if (!version || !SEMVER.test(version)) {
  console.error(
    `Usage: set-version.mjs <semver>  (got: ${version ?? "nothing"})`,
  );
  process.exit(1);
}

// Rewrite in place so the rest of the file keeps its formatting.
const source = readFileSync(confPath, "utf8");
const next = source.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
if (next === source && !source.includes(`"version": "${version}"`)) {
  console.error("Could not find the version field in tauri.conf.json");
  process.exit(1);
}
writeFileSync(confPath, next);
console.log(`tauri.conf.json version set to ${version}`);
