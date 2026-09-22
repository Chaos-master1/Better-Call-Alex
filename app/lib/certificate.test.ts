/**
 * certificate.ts tests — deterministic digests, canonical JSON, tamper
 * detection. Pure module: no DB, no corpus.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVerificationCertificate,
  canonicalJson,
  sha256Hex,
  verifyCertificate,
  type CertifiableDraft,
} from "./certificate.js";

const DRAFT: CertifiableDraft = {
  banner: "DRAFT — REQUIRES LICENSED REVIEW — NOT LEGAL ADVICE",
  title: "Research: trespass",
  verification: { overall: "pass", summary: { citations: 3, quotes: 2 } },
  authority_appendix: [
    {
      citation: "410 U.S. 113",
      case_name: "Roe v. Wade",
      verified: true,
      inferred_treatment: [],
    },
    {
      citation: "494 U.S. 560",
      case_name: null,
      verified: false,
      inferred_treatment: ["overruled"],
      ambiguous: false,
    },
  ],
};

test("canonicalJson is key-order independent", () => {
  assert.equal(canonicalJson({ a: 1, b: [2, { c: 3 }] }), canonicalJson({ b: [2, { c: 3 }], a: 1 }));
  assert.equal(canonicalJson({}), "{}");
  assert.equal(canonicalJson(null), "null");
});

test("sha256Hex is the standard digest", () => {
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});

test("certificate is deterministic: same draft, same digest", () => {
  const a = buildVerificationCertificate(DRAFT, {
    caseId: 1,
    runId: 7,
    auditRowId: 42,
    engines: [{ stage: "analyst", engine: "cloud", model: "gpt-5" }],
    generatedAt: "2026-09-22T00:00:00Z",
  });
  const b = buildVerificationCertificate(DRAFT, {
    caseId: 1,
    runId: 7,
    auditRowId: 42,
    engines: [{ stage: "analyst", engine: "cloud", model: "gpt-5" }],
    generatedAt: "2026-09-22T00:00:00Z",
  });
  assert.equal(a.draft_sha256, b.draft_sha256);
  assert.equal(a.audit_row_id, 42);
  assert.equal(a.overall, "pass");
});

test("verifyCertificate passes on the original draft, fails on any edit", () => {
  const cert = buildVerificationCertificate(DRAFT, {
    caseId: 1,
    runId: 7,
    auditRowId: 42,
    engines: [],
    generatedAt: "2026-09-22T00:00:00Z",
  });
  assert.deepEqual(verifyCertificate(cert, DRAFT), []);

  // A single-word edit in the title must break the digest — the whole
  // point of the artifact.
  const tampered: CertifiableDraft = { ...DRAFT, title: "Research: trespass " };
  const problems = verifyCertificate(cert, tampered);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /digest mismatch/);

  // A dropped citation must be caught by the appendix cross-check too.
  const missing: CertifiableDraft = {
    ...DRAFT,
    authority_appendix: DRAFT.authority_appendix.slice(0, 1),
  };
  assert.ok(verifyCertificate(cert, missing).length >= 1);
});

test("certificate carries per-citation verdicts and engine provenance", () => {
  const cert = buildVerificationCertificate(DRAFT, {
    caseId: 3,
    runId: null,
    auditRowId: null,
    engines: [
      { stage: "intake", engine: "local", model: "qwen3.5:9b" },
      { stage: "analyst", engine: "cloud", model: "gpt-5" },
    ],
  });
  assert.equal(cert.citations[0].status, "verified");
  assert.equal(cert.citations[1].status, "unverified");
  assert.equal(cert.citations[1].inferred_treatment[0], "overruled");
  assert.equal(cert.engines[1].engine, "cloud");
  assert.match(cert.statement, /append-only audit log/);
  assert.ok(cert.audit_row_id === null); // legacy drafts anchor to nothing, honestly
});
