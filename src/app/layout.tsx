import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AdMate — AI marketing analyst",
  description:
    "Upload your ad report. Understand what's working, what's not, and what to do next.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
