import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Indexly — SEO Change Monitor",
  description: "Catch SEO changes before they cost you traffic.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
