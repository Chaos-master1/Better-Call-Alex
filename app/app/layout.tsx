import type { Metadata } from "next";
import "./alex.css";

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
      <body>{children}</body>
    </html>
  );
}
