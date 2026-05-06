/**
 * Rewrites <a href="..."> links in HTML to go through a tracking redirect.
 * Returns the modified HTML and a linkMap mapping index → original URL.
 */
export function rewriteLinksForTracking(
  bodyHtml: string,
  trackingId: string,
  baseUrl: string,
): { html: string; linkMap: Record<string, string> } {
  const linkMap: Record<string, string> = {};
  let index = 0;

  const html = bodyHtml.replace(
    /<a\s+([^>]*?)href=["']([^"']+)["']([^>]*?)>/gi,
    (match, before, href, after) => {
      // Skip mailto: links, anchor links, and tracking pixels
      if (href.startsWith('mailto:') || href.startsWith('#') || href.startsWith('javascript:')) {
        return match;
      }

      const linkIndex = index++;
      linkMap[String(linkIndex)] = href;
      const trackingUrl = `${baseUrl}/t/${trackingId}/${linkIndex}`;
      return `<a ${before}href="${trackingUrl}"${after}>`;
    },
  );

  return { html, linkMap };
}
