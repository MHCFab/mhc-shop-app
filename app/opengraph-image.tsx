// ---------------------------------------------------------------------------
// The picture that shows when someone pastes a shopworks.app link into a
// text, email, Facebook or LinkedIn. SEO-BASICS-V1
//
// Drawn at build time by Next itself - no image file to keep up to date, and
// no font download (it uses Next's built-in font).
// ⚠️ middleware.ts lets /opengraph-image through without a login, or link
// previews would show the sign-in page instead.
// ---------------------------------------------------------------------------

import { ImageResponse } from "next/og";

export const alt = "ShopWorks - shop software built by a fabricator";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: "#181e24",
          color: "#ffffff",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", fontSize: 40, fontWeight: 800 }}>
          <div
            style={{
              width: 26,
              height: 26,
              background: "#c8551f",
              transform: "rotate(45deg)",
              marginRight: 22,
            }}
          />
          ShopWorks
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 84, fontWeight: 800, lineHeight: 1.05, letterSpacing: -2 }}>
            Shop software built by a fabricator.
          </div>
          <div style={{ marginTop: 28, fontSize: 34, color: "#c9ced4" }}>
            Jobs, material, the floor, job costing and a customer portal.
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 30, color: "#e08a5c" }}>
          From $149/month per shop. 14-day free trial, no card.
        </div>
      </div>
    ),
    size
  );
}
