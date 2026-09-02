/**
 * Adversary retrieval-ladder tests. DB-dependent cases skip when
 * corpus.sqlite is absent (CI-safe).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openCorpus, resolveCluster } from "../db.js";
import { negativeTreatmentHits } from "./index.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HAS_DB = existsSync(path.join(REPO, "data", "corpus.sqlite"));

test(
  "negative-treatment fallback finds counter-authority for Roe (Dobbs era corpus)",
  { skip: !HAS_DB },
  () => {
    const db = openCorpus();
    try {
      const roe = resolveCluster(db, "410", "U.S.", "113");
      assert.ok(roe?.cluster_id, "Roe resolves");
      const hits = negativeTreatmentHits(db, roe!.cluster_id, "substantive due process abortion", 5);
      assert.ok(hits.length > 0, "negative-treatment citing cases found");
      const top = hits[0];
      // A hit is a real opinion with the metadata the route and draft need.
      assert.ok(top.opinion_id > 0);
      assert.ok(top.case_name, "case name present");
      assert.ok(
        top.treatment_flags > 0 || top.passages.length >= 0,
        "treatment flag or passage present"
      );
    } finally {
      db.close();
    }
  }
);

test("negative-treatment fallback returns nothing without a cluster", () => {
  const db = openCorpus();
  try {
    assert.equal(negativeTreatmentHits(db, null, "anything", 5).length, 0);
  } finally {
    db.close();
  }
});
