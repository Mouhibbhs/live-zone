import type { Metadata } from "next";

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
        {children}
      </body>
    </html>
  );
}
