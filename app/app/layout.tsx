import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Better Call Alex",
  description: "US case-law research workbench — local, verifiable",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        margin: 0,
        padding: 0,
        background: "#0a0a0a",
        color: "#e5e5e5",
      }}>
        {children}
      </body>
    </html>
  );
}
