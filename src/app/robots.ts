import type { MetadataRoute } from 'next';

// Private app: ask every crawler to stay out (pages also carry a noindex meta tag).
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', disallow: '/' } };
}
