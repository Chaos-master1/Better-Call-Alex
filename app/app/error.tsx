"use client";

/**
 * Route error boundary. The Result component dereferences deep server
 * shapes (scores, passages, report fields); a shape drift or render throw
 * must show a recoverable panel, never a blank app.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main style={{ maxWidth: 720, margin: "80px auto", padding: "0 16px" }}>
      <h1 style={{ fontSize: 20 }}>Something failed while rendering the result.</h1>
      <p style={{ color: "#8a8a8a", fontSize: 13 }}>
        The run data is still stored in the case database — rerun or reload to
        retry. {error.digest ? `(digest: ${error.digest})` : null}
      </p>
      <button
        onClick={reset}
        style={{
          marginTop: 16,
          padding: "9px 18px",
          background: "#1d4ed8",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          cursor: "pointer",
          fontSize: 14,
          fontWeight: 600,
        }}
      >
        Try again
      </button>
    </main>
  );
}
