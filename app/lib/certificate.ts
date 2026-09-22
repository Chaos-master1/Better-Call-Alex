/**
 * Verification Certificate (Phase A — "genius move 2").
 *
 * Every exported document ships with a machine-checkable proof artifact:
 *   - every citation in the draft, with its resolution verdict;
 *   - every quote check the verifier performed;
 *   - the overall verdict and its summary counts;
 *   - the engine provenance (which engine/model produced each stage);
 *   - a SHA-256 digest over the CANONICAL draft JSON, chained to the
 *     append-only audit_log row id that carried the verifier's report.
 *
 * The chain matters: audit_log is trigger-enforced append-only (§5.6), so
 * a certificate naming audit row N is evidence that the verifier verdict
 * existed at run time and was not retro-fitted. The certificate itself is
 * regenerated deterministically from the stored draft — same draft JSON
 * ⇒ same digest — so anyone can re-verify it without trusting the
 * generator, exactly the property §3's "computed, never inferred" wants.
 *
 * This module is PURE (no DB, no I/O) so it is unit-testable corpus-free,
 * like export_docx.ts. The route wires it to the stored draft + audit row.
 */
import { createHash } from "node:crypto";

export interface CertificateCitation {
  citation: string;
  case_name: string | null;
  status: string;
  verified: boolean;
  inferred_treatment: string[];
  ambiguous: boolean;
}

export interface VerificationCertificate {
  /** Schema version — bump when the artifact shape changes. */
  schema: "alex-verification-certificate/v1";
  issued_at: string;
  case_id: number;
  run_id: number | null;
  /** SHA-256 over the canonical JSON of the certified draft document. */
  draft_sha256: string;
  /** The audit_log row id whose payload carries the verifier report this
   *  certificate summarizes. Append-only ⇒ tamper-evident anchor. */
  audit_row_id: number | null;
  overall: "pass" | "fail";
  summary: Record<string, number>;
  /** Structured verdict breakdown; present when the draft was rendered by
   *  a verdict-aware build (optional — older artifacts stay valid). */
  verdict?: {
    sentences_total: number;
    sentences_verified: number;
    sentences_struck: number;
    citations_extracted: number;
    citations_verified: number;
    quotes_checked: number;
    quotes_verified: number;
    failures: Array<{ index: number; tag: string; reason: string }>;
  };
  banner: string;
  /** Per-citation proof (the appendix, with verification verdicts). */
  citations: CertificateCitation[];
  /** Per-stage engine provenance (ADR-004). */
  engines: Array<{ stage: string; engine: string; model: string }>;
  /** Human-readable statement of what this certificate claims. */
  statement: string;
}

/** Stable JSON.stringify: sorted object keys, arrays in order. The digest
 *  is only re-computable if serialization is deterministic. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Minimal structural subset of DraftDoc the certificate reads. */
export interface CertifiableDraft {
  banner: string;
  title: string;
  verification: {
    overall: string;
    summary: Record<string, number>;
    verdict?: {
      sentences_total: number;
      sentences_verified: number;
      sentences_struck: number;
      citations_extracted: number;
      citations_verified: number;
      quotes_checked: number;
      quotes_verified: number;
      failures: Array<{ index: number; tag: string; reason: string }>;
    };
  };
  authority_appendix: Array<{
    citation: string;
    case_name: string | null;
    verified: boolean;
    inferred_treatment: string[];
    ambiguous?: boolean;
  }>;
}

/**
 * Build the certificate for a draft. `auditRowId` is the verifier.run
 * audit row (or the drafter.render row for re-exports); null is allowed
 * for legacy drafts whose runs predate the certificate — the artifact
 * still certifies the draft digest, just without the audit anchor.
 */
export function buildVerificationCertificate(
  drafted: CertifiableDraft,
  opts: {
    caseId: number;
    runId: number | null;
    auditRowId: number | null;
    engines: Array<{ stage: string; engine: string; model: string }>;
    generatedAt?: string;
  }
): VerificationCertificate {
  const draftDigest = sha256Hex(canonicalJson(drafted));
  const citations: CertificateCitation[] = (drafted.authority_appendix ?? []).map((a) => ({
    citation: a.citation,
    case_name: a.case_name,
    status: a.verified ? "verified" : "unverified",
    verified: !!a.verified,
    inferred_treatment: a.inferred_treatment ?? [],
    ambiguous: !!a.ambiguous,
  }));
  const overall = drafted.verification?.overall === "pass" ? "pass" : "fail";
  const verdict = drafted.verification?.verdict;
  return {
    schema: "alex-verification-certificate/v1",
    issued_at: opts.generatedAt ?? new Date().toISOString(),
    case_id: opts.caseId,
    run_id: opts.runId,
    draft_sha256: draftDigest,
    audit_row_id: opts.auditRowId,
    overall,
    summary: drafted.verification?.summary ?? {},
    ...(verdict ? { verdict } : {}),
    banner: drafted.banner,
    citations,
    engines: opts.engines,
    statement:
      `This certificate attests that the document with SHA-256 ${draftDigest.slice(0, 16)}… ` +
      `was produced by Better Call Alex and gated by its verifier: every citation ` +
      `resolved against the corpus (${citations.filter((c) => c.verified).length}/${citations.length} appendix citations verified), ` +
      `every quoted span matched the cited opinion's text, and the verdict was recorded ` +
      `in the append-only audit log${opts.auditRowId != null ? ` (row ${opts.auditRowId})` : ""}. ` +
      `Treatment signals are INFERRED, never asserted. Re-verify: recompute SHA-256 over ` +
      `the canonical JSON of the draft and compare.`,
  };
}

/** Re-verify an existing certificate against a draft: the digest must match
 *  exactly. Returns the mismatch list (empty = valid). */
export function verifyCertificate(
  cert: VerificationCertificate,
  drafted: CertifiableDraft
): string[] {
  const problems: string[] = [];
  const digest = sha256Hex(canonicalJson(drafted));
  if (digest !== cert.draft_sha256) {
    problems.push(
      `draft digest mismatch: certificate says ${cert.draft_sha256.slice(0, 16)}…, draft computes ${digest.slice(0, 16)}…`
    );
  }
  if (cert.schema !== "alex-verification-certificate/v1") {
    problems.push(`unknown certificate schema ${cert.schema}`);
  }
  const certCites = new Map(cert.citations.map((c) => [c.citation, c]));
  for (const a of drafted.authority_appendix ?? []) {
    const c = certCites.get(a.citation);
    if (!c) problems.push(`certificate missing appendix citation ${a.citation}`);
    else if (c.verified !== a.verified) {
      problems.push(`verification verdict drift for ${a.citation}`);
    }
  }
  return problems;
}
