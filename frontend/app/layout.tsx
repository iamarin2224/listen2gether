import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SyncWave",
  description: "Real-time synchronized music listening — listen together, in perfect sync.",
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-gray-900 text-white antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
