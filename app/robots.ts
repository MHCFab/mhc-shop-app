// ---------------------------------------------------------------------------
// /robots.txt - what search engines may crawl. SEO-BASICS-V1
//
// Only the public pages are worth indexing. Everything behind a login is
// listed as off-limits so crawlers don't waste time being bounced to /login.
// ⚠️ middleware.ts lets /robots.txt through without a login - without that it
// would redirect to the sign-in page and Google would never read this.
// ---------------------------------------------------------------------------

import type { MetadataRoute } from "next";

const SITE = "https://www.shopworks.app";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/signup", "/terms", "/privacy"],
        disallow: [
          "/admin",
          "/floor",
          "/portal",
          "/billing",
          "/api/",
          "/accept-invite",
          "/reset-password",
          "/new-shop",
          "/signup/confirm",
          "/onboarding/",
        ],
      },
    ],
    sitemap: SITE + "/sitemap.xml",
    host: SITE,
  };
}
