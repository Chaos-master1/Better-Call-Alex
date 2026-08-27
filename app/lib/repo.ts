/**
 * Repository root resolution. `import.meta.dirname` is `undefined` inside
 * a webpack-bundled Next.js server route. The CLI (NodeNext) sees it
 * fine. Both callers want the same result: the path that contains
 * `data/corpus.sqlite`. Prefer the explicit env var, fall back to
 * `import.meta.dirname`, then to `process.cwd()`.
 */
import path from "node:path";

export function resolveRepo(): string {
  if (process.env.ALEX_REPO) return process.env.ALEX_REPO;
  if (typeof import.meta.dirname === "string") {
    return path.resolve(import.meta.dirname, "..", "..");
  }
  return path.resolve(process.cwd(), "..");
}
