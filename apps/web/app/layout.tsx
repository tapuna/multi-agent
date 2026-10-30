import "./globals.css";
import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "Relay · Engineering Control Center",
  description: "Tasks, agents, and engineering work in one control center.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
