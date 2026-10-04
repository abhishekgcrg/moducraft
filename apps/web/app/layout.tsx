import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ModuCraft",
  description: "Your self-hostable AI development platform.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
