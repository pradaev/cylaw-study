import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin", "greek"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Κυπριακή Νομολογία",
  description:
    "Βοηθός νομικής έρευνας με τεχνητή νοημοσύνη για κυπριακές δικαστικές αποφάσεις. Αναζήτηση σε 150.000+ αποφάσεις.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="el">
      <body className={`${inter.variable} font-sans antialiased bg-white text-gray-900`}>
        {children}
      </body>
    </html>
  );
}
