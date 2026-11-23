import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  // Lets every page's link-preview image and canonical address be written as
  // a short path ("/") and come out as a full www.shopworks.app address.
  metadataBase: new URL("https://www.shopworks.app"),
  title: "ShopWorks",
  description: "Shop management, built for the floor.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "ShopWorks",
  },
  icons: {
    icon: "/favicon.ico",
    apple: "/icon-180.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#181e24",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-50 min-h-screen">{children}</body>
    </html>
  );
}