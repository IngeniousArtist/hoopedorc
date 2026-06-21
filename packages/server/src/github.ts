import { execFileSync } from "node:child_process";

// Creates a fresh private GitHub repo for a "start from nothing" project, using
// the already-authenticated `gh` CLI. We seed a minimal package.json so the
// pre-merge gates (`npm run <script> --if-present`) pass on the first task — an
// empty repo with no package.json makes npm exit non-zero and fails every gate.

function gh(args: string[]): string {
  return execFileSync("gh", args, {
    stdio: "pipe",
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Fetch a PR's unified diff via `gh pr diff`. */
export function getPrDiff(repoUrl: string, prNumber: number): string {
  return gh(["pr", "diff", String(prNumber), "--repo", repoUrl]);
}

/** Turn a project name into a valid GitHub repo slug. */
export function slugifyRepoName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || "hoopedorc-project";
}

export interface CreatedRepo {
  repoUrl: string;
  nameWithOwner: string;
}

/**
 * Create a private repo `<owner>/<name>` with a README + a minimal package.json,
 * and return its https URL. Throws (with gh's message) if the name is taken or
 * gh is not authenticated — the caller surfaces that to the UI.
 */
export function createGithubRepo(rawName: string): CreatedRepo {
  const name = slugifyRepoName(rawName);

  // `gh repo create <name> --private --add-readme` prints the new repo's URL.
  const out = gh(["repo", "create", name, "--private", "--add-readme"]).trim();
  const urlMatch = out.match(/https:\/\/github\.com\/[^\s]+/);

  const owner = gh(["api", "user", "-q", ".login"]).trim();
  const nameWithOwner = `${owner}/${name}`;
  const repoUrl = urlMatch ? urlMatch[0] : `https://github.com/${nameWithOwner}`;

  // Seed a minimal package.json on the default branch via the contents API so we
  // don't need a local clone. `--if-present` then no-ops cleanly on missing
  // scripts instead of erroring on a missing package.json.
  const pkg = JSON.stringify(
    { name, private: true, version: "0.0.0" },
    null,
    2,
  );
  const content = Buffer.from(`${pkg}\n`, "utf8").toString("base64");
  gh([
    "api",
    "--method",
    "PUT",
    `repos/${nameWithOwner}/contents/package.json`,
    "-f",
    "message=chore: seed package.json (hoopedorc)",
    "-f",
    `content=${content}`,
  ]);

  // Seed a .gitignore so build artifacts the orchestrator/agents generate
  // (node_modules, lockfile churn, env files, OS cruft) never get committed
  // into task PRs — without this, `git add -A` in a worktree commits
  // node_modules and the inScope gate fails every task.
  const gitignore = [
    "node_modules/",
    ".hoopedorc-deps-hash",
    "dist/",
    "build/",
    ".next/",
    "out/",
    ".env",
    ".env.*",
    "*.log",
    ".DS_Store",
    "",
  ].join("\n");
  const giContent = Buffer.from(gitignore, "utf8").toString("base64");
  gh([
    "api",
    "--method",
    "PUT",
    `repos/${nameWithOwner}/contents/.gitignore`,
    "-f",
    "message=chore: seed .gitignore (hoopedorc)",
    "-f",
    `content=${giContent}`,
  ]);

  return { repoUrl, nameWithOwner };
}
