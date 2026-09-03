/**
 * Route degradation tests — real handlers, tmp app DB (ALEX_APP_DB), and
 * NO corpus.sqlite (it is being rebuilt), so every corpus-dependent path
 * must answer 503 JSON, never throw HTML.
 *
 * Each test isolates env + tmp dirs it creates; the production
 * data/app.sqlite is never opened.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openAppAt } from "../lib/app_db.js";
import { GET as lookupGET } from "../app/api/lookup/route.js";
import { GET as searchGET } from "../app/api/search/route.js";
import { GET as casesGET } from "../app/api/cases/route.js";
import { GET as exportGET } from "../app/api/cases/[id]/export/route.js";

let dir = "";
let appDb = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "alex-routes-"));
  appDb = path.join(dir, "app.sqlite");
  // Real schema, empty: routes see a healthy app DB with no cases/runs.
  openAppAt(appDb).close();
  process.env.ALEX_APP_DB = appDb;
});

afterEach(() => {
  delete process.env.ALEX_APP_DB;
});

async function bodyJson(r: Response): Promise<{ status: number; json: unknown }> {
  const status = r.status;
  const text = await r.text();
  try {
    return { status, json: JSON.parse(text) };
  } catch {
    assert.fail(`non-JSON response (status ${status}): ${text.slice(0, 200)}`);
  }
}

test("lookup without corpus answers 503 JSON, not HTML", async () => {
  const { status, json } = await bodyJson(
    await lookupGET(new Request("http://x/api/lookup?cite=410%20U.S.%20113"))
  );
  assert.equal(status, 503);
  assert.match((json as { error: string }).error, /corpus database unavailable/);
});

test("lookup validates input before touching any DB", async () => {
  const empty = await bodyJson(await lookupGET(new Request("http://x/api/lookup?cite=")));
  assert.equal(empty.status, 400);
  const huge = await bodyJson(
    await lookupGET(new Request(`http://x/api/lookup?cite=${"1".repeat(300)}`))
  );
  assert.equal(huge.status, 400);
});

test("search without corpus answers 503 JSON; empty q is 400", async () => {
  const { status } = await bodyJson(await searchGET(new Request("http://x/api/search?q=test")));
  assert.equal(status, 503);
  const bad = await bodyJson(await searchGET(new Request("http://x/api/search?q=")));
  assert.equal(bad.status, 400);
});

test("cases list on empty app DB is 200 with no cases", async () => {
  const { status, json } = await bodyJson(await casesGET());
  assert.equal(status, 200);
  assert.deepEqual((json as { cases: unknown[] }).cases, []);
});

test("export with no drafted run is 404 JSON", async () => {
  const { status, json } = await bodyJson(
    await exportGET(new Request("http://x/api/cases/1/export"), {
      params: Promise.resolve({ id: "1" }),
    } as never)
  );
  assert.equal(status, 404);
  assert.match((json as { error: string }).error, /no drafted run/);
});

test("export rejects a bad case id with 400 JSON", async () => {
  const { status } = await bodyJson(
    await exportGET(new Request("http://x/api/cases/abc/export"), {
      params: Promise.resolve({ id: "abc" }),
    } as never)
  );
  assert.equal(status, 400);
});
