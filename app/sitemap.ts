// ---------------------------------------------------------------------------
// /sitemap.xml - the public pages, for search engines. SEO-BASICS-V1
// Add any new public marketing page here when it is built.
// ---------------------------------------------------------------------------

import type { MetadataRoute } from "next";

const SITE = "https://www.shopworks.app";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE + "/", changeFrequency: "weekly", priority: 1 },
    { url: SITE + "/signup", changeFrequency: "monthly", priority: 0.8 },
    { url: SITE + "/terms", changeFrequency: "yearly", priority: 0.2 },
    { url: SITE + "/privacy", changeFrequency: "yearly", priority: 0.2 },
  ];
}
