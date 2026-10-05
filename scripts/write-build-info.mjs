// Writes dist/build-info.json at build time: the app version (from package.json — the single source
// of truth) and the git commit the build was made from. The packaged app reads this file, so the
// merchant PC never needs git. Run by `npm run build`.
//
// Commit source, in order: ALZABT_BUILD_SHA (set by CI), else `git rev-parse` of the checkout, else
// "unknown". A local build from a working tree with uncommitted changes is marked "-dirty".
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

let sha = (process.env.ALZABT_BUILD_SHA ?? "").trim();
let dirty = false;
if (!sha) {
  sha = git(["rev-parse", "--short=7", "HEAD"]) ?? "unknown";
  dirty = sha !== "unknown" && (git(["status", "--porcelain", "--untracked-files=no"]) ?? "") !== "";
}
if (!/^[0-9a-f]{7,40}$|^unknown$/.test(sha)) {
  console.error(`write-build-info: refusing malformed build sha '${sha}'`);
  process.exit(1);
}

const info = {
  version: pkg.version,
  build: dirty ? `${sha.slice(0, 7)}-dirty` : sha.slice(0, 7),
  builtAt: new Date().toISOString(),
};
const out = join(root, "dist", "build-info.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(info, null, 2) + "\n", "utf8");
console.log(`build-info: Alzabt POS ${info.version} · Build ${info.build}`);
