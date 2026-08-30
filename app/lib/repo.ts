/**
 * Repository root resolution. `import.meta.dirname` is `undefined` inside
 * a webpack-bundled Next.js server route. The CLI (NodeNext) sees it
 * fine. Both callers want the same result: the path that contains
 * `data/corpus.sqlite`. Prefer the explicit env var, fall back to
 * `import.meta.dirname`, then to `process.cwd()`.
 *
 * P1-1: walks up looking for a repo marker (CLAUDE.md / app/package.json /
 * data/) so CWD = app/ vs CWD = repo/ both resolve to the same root.
 */
import fs from "node:fs";
import path from "node:path";

function isRepoRoot(dir: string): boolean {
  try {
    // Cheap markers that exist only at the repo root.
    if (fs.existsSync(path.join(dir, "CLAUDE.md"))) return true;
    if (fs.existsSync(path.join(dir, "app", "package.json"))) return true;
    if (fs.existsSync(path.join(dir, "data"))) return true;
    return false;
  } catch {
    return false;
  }
}

function walkUp(start: string): string | null {
  let cur = path.resolve(start);
  for (let i = 0; i < 10; i++) {
    if (isRepoRoot(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export function resolveRepo(): string {
  if (process.env.ALEX_REPO) return process.env.ALEX_REPO;
  const candidates: string[] = [];
  if (typeof import.meta.dirname === "string") {
    candidates.push(path.resolve(import.meta.dirname, "..", ".."));
    candidates.push(import.meta.dirname);
  }
  candidates.push(process.cwd());
  // First, try the candidates directly (fast path for the common case).
  for (const c of candidates) {
    if (isRepoRoot(path.resolve(c))) return path.resolve(c);
  }
  // Then walk up from each candidate.
  for (const c of candidates) {
    const found = walkUp(c);
    if (found) return found;
  }
  // Last resort: legacy behaviour so we never throw in a minimal checkout.
  if (typeof import.meta.dirname === "string") {
    return path.resolve(import.meta.dirname, "..", "..");
  }
  return path.resolve(process.cwd(), "..");
}
