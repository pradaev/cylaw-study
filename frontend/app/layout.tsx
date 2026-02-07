import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin", "greek"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Cyprus Case Law",
  description:
    "AI-powered legal research assistant for Cypriot court cases. Search through 150,000+ court decisions.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} font-sans antialiased bg-[#0f1117] text-zinc-200`}>
        {children}
      </body>
    </html>
  );
}
