import type { Metadata } from "next";
import Script from "next/script";

import "../src/app/globals.css";

export const metadata: Metadata = {
  title: "LiveZone",
  description: "LiveZone IPTV subscription platform for live TV channels only.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <Script
          src="https://cdn.jsdelivr.net/npm/mpegts.js@latest/dist/mpegts.min.js"
          strategy="beforeInteractive"
        />
        {children}
      </body>
    </html>
  );
}
