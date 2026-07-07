// ─────────────────────────────────────────────────────────────────────────────
// trackingInject.ts — open/click tracking injection for outgoing email HTML.
//
// Called from emails.actuallySend at the moment of send, on the OUTGOING
// copy only: the pixel + rewritten links go to the provider, while the local
// emailBodies copy keeps the clean original — so viewing your own sent mail
// in Orbi never fires your own tracker.
//
// Pixel:  <img src="{site}/p/{trackingId}.png"> → tracking/pixel.ts
// Links:  href="https://x" → "{site}/t/{trackingId}/{index}" with the
//         original stored in emailTracking.linkMap → tracking/links.ts 302s.
// ─────────────────────────────────────────────────────────────────────────────

const HREF_RE = /(<a\b[^>]*?\bhref=")(https?:\/\/[^"]+)(")/gi;

export function injectTracking(
  bodyHtml: string,
  trackingId: string,
  siteUrl: string,
): { html: string; linkMap: Record<string, string> } {
  const linkMap: Record<string, string> = {};
  let index = 0;

  let html = bodyHtml.replace(HREF_RE, (_m, pre: string, url: string, post: string) => {
    // Leave unsubscribe-ish links alone — breaking those harms deliverability
    // and recipient trust.
    if (/unsubscribe|list-manage|opt[-_]?out/i.test(url)) {
      return `${pre}${url}${post}`;
    }
    const i = String(index++);
    linkMap[i] = url;
    return `${pre}${siteUrl}/t/${trackingId}/${i}${post}`;
  });

  const pixel = `<img src="${siteUrl}/p/${trackingId}.png" width="1" height="1" style="display:none;max-height:1px;max-width:1px;" alt="" />`;
  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, `${pixel}</body>`);
  } else {
    html = `${html}${pixel}`;
  }

  return { html, linkMap };
}
