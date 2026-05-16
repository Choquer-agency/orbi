"use node";

// ─────────────────────────────────────────────────────────────────────────────
// emailPreprocess.ts — server-side, run-once email body normalization.
//
// Why this exists
// ───────────────
// Gmail/Outlook/Spark all preprocess email HTML once on ingest and store the
// result. Their clients render a near-string-paste from disk on every open,
// which is why opening email N+1 feels instant.
//
// We previously did *all* of this work in the browser on every render:
//   - DOMPurify sanitize
//   - Strip quoted content
//   - Mark CID images
//   - Trim whitespace blocks
//   - Re-flow the iframe height
//
// Now we run sanitize + quote-strip + a tasteful whitespace cleanup once
// during sync, and the client just plugs the result into <iframe srcdoc>.
//
// Outputs persisted alongside `bodyHtml`:
//   - bodyHtmlClean      Sanitized full email (still includes quoted history)
//   - bodyHtmlTrimmed    Sanitized + quoted history removed
//   - hasQuotedHistory   Boolean — whether bodyHtmlClean and Trimmed differ
//   - isForwarded        Boolean — explicit "Forwarded message" markers found
// ─────────────────────────────────────────────────────────────────────────────

import sanitizeHtml from "sanitize-html";
import { load as cheerioLoad } from "cheerio";

export type PreprocessedBody = {
  bodyHtmlClean: string | undefined;
  bodyHtmlTrimmed: string | undefined;
  hasQuotedHistory: boolean;
  isForwarded: boolean;
};

const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  // Mail HTML is layout-heavy; allow tables, inline styles, and most
  // formatting tags. Block scripts, forms, iframes, and event handlers.
  allowedTags: [
    "html", "head", "body", "style", "meta", "title",
    "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo",
    "blockquote", "br", "caption", "cite", "code", "col", "colgroup",
    "data", "dd", "del", "details", "dfn", "div", "dl", "dt", "em",
    "fieldset", "figcaption", "figure", "footer", "h1", "h2", "h3",
    "h4", "h5", "h6", "header", "hgroup", "hr", "i", "img", "ins",
    "kbd", "label", "legend", "li", "main", "mark", "nav", "ol",
    "p", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section",
    "small", "span", "strong", "sub", "summary", "sup", "table",
    "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul",
    "var", "wbr", "center", "font",
  ],
  allowedAttributes: {
    "*": [
      "id", "class", "style", "title", "align", "valign", "border",
      "cellpadding", "cellspacing", "colspan", "rowspan", "width",
      "height", "bgcolor", "background", "color", "size", "face",
      "dir", "lang",
      "data-cid-email", "data-cid-attachment",
    ],
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt", "width", "height", "border", "referrerpolicy",
          "data-cid-email", "data-cid-attachment"],
    table: ["summary"],
    th: ["scope"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel", "data", "cid"],
  allowedSchemesByTag: {
    img: ["http", "https", "data", "cid"],
  },
  // Allow inline <style> blocks — marketing emails depend on them.
  allowedStyles: false as any, // pass-through styles
  allowVulnerableTags: true, // for <style>; we accept the trade-off inside an iframe sandbox
  parseStyleAttributes: false,
  transformTags: {
    // Strip Microsoft conditional comments noise where it leaks through.
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        target: "_blank",
        rel: "noopener noreferrer",
      },
    }),
    img: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        referrerpolicy: attribs.referrerpolicy || "no-referrer",
      },
    }),
  },
};

function isForwardedEmail(
  html: string,
  text: string,
  subject: string | undefined,
): boolean {
  // Reply chains often quote a forwarded message inside their history,
  // which made our body-only heuristic wrongly flag normal replies as
  // forwards. Require the subject to actually carry a Fwd:/FW:/TR:/etc.
  // prefix — every mail client adds one to genuine forwards.
  const subj = (subject ?? "").trim();
  if (!/^\s*(fwd?|fw|tr|wg|rv|enc):/i.test(subj)) return false;

  const probe = `${text}\n${html.replace(/<[^>]+>/g, " ")}`;
  return (
    /(?:^|\n)\s*-{2,}\s*(forwarded|original)\s+message\b/i.test(probe) ||
    /(?:^|\n)\s*begin forwarded message\b/i.test(probe) ||
    /(?:^|\n)\s*forwarded message\s*$/im.test(probe)
  );
}

/**
 * Removes quoted reply history. Same algorithm as the original client-side
 * stripQuotedContent (in EmailViewer.tsx) but running on jsdom so it can
 * be done once on the server.
 */
function stripQuoted(html: string): { body: string; hasQuoted: boolean } {
  // cheerio is pure JS — no DOM polyfill, runs in Convex's V8 sandbox.
  const $ = cheerioLoad(`<!doctype html><html><body>${html}</body></html>`);
  const body = $("body");

  // Phase 1: known wrapper elements
  body.find(
    [
      ".gmail_quote", ".gmail_extra", ".gmail_attr",
      "#appendonsend", "#divRplyFwdMsg", '[name="divRplyFwdMsg"]',
      ".yahoo_quoted",
      'blockquote[type="cite"]', "blockquote.cite",
    ].join(","),
  ).remove();

  // Phase 2: scan for quote markers
  const quoteStartPatterns = [
    /On\s+.{5,120}\s+wrote:\s*$/,
    /wrote:\s*$/,
    /^-{3,}\s*(Forwarded|Original)\s*(message|Message)/i,
    /^_{5,}/,
    /^Begin forwarded message/i,
  ];
  const headerPattern = /^From:\s+.+/im;
  const sentPattern = /^Sent:\s+.+/im;

  let cutEl: any = null;
  body.find("*").each((_i, raw) => {
    if (cutEl) return false;
    const el = $(raw);
    const fullText = (el.text() ?? "").trim();
    if (fullText.length < 3) return;
    if (
      fullText.length < 500 &&
      headerPattern.test(fullText) &&
      sentPattern.test(fullText)
    ) {
      cutEl = raw;
      return false;
    }
    // Only the direct text-node children (cheerio: contents().filter type=='text').
    const directText = el
      .contents()
      .filter((_j, c: any) => c.type === "text")
      .map((_j, c: any) => (c.data ?? "").trim())
      .get()
      .join(" ")
      .trim();
    if (directText.length < 3) return;
    if (quoteStartPatterns.some((p) => p.test(directText))) {
      cutEl = raw;
      return false;
    }
  });

  // Track whether any of the phases below actually removed *quoted reply
  // content* (not just sanitization noise). Marketing emails go through this
  // function too and should never be flagged as having history.
  let removedQuoted = false;

  if (cutEl) {
    let target = $(cutEl);
    const bodyLen = body.html()?.length ?? 0;
    // Walk up until the parent would swallow most of the body.
    while (true) {
      const parent = target.parent();
      if (!parent.length || parent.is("body")) break;
      if ((parent.html()?.length ?? 0) > bodyLen * 0.85) break;
      target = parent;
    }
    // Remove target and every following sibling.
    target.nextAll().remove();
    target.remove();
    removedQuoted = true;
  }

  // Phase 3: catch-all blockquotes — only count if at least one had quote-y
  // text content (ignoring decorative blockquotes used as styling in some
  // marketing templates).
  body.find("blockquote").each((_i, bq) => {
    const t = $(bq).text().trim();
    if (t.length > 20) removedQuoted = true;
    $(bq).remove();
  });

  // Phase 4: hr followed by From:
  body.find("hr").each((_i, hr) => {
    const nextText = $(hr).next().text().trim();
    if (/^(From|De|Von|Da):\s/i.test(nextText)) {
      $(hr).nextAll().remove();
      $(hr).remove();
      removedQuoted = true;
    }
  });

  const cleaned = body.html() ?? "";
  return { body: cleaned, hasQuoted: removedQuoted };
}

/**
 * Run-once whitespace cleanup. Removes runs of empty wrappers / extra <br>s
 * (Outlook + Apple Mail signatures) but keeps a single blank line so the
 * paragraph→signature spacing matches Gmail/Spark.
 */
function trimWhitespaceServer(html: string): string {
  if (!html) return html;
  const $ = cheerioLoad(`<!doctype html><html><body>${html}</body></html>`);
  const body = $("body");

  body.find("br").each((_i, br) => {
    // Skip <br>s that live inside a table — those are intentional layout
    // beats in email signatures (Outlook / Apple Mail / Spark all use
    // table-based signatures and rely on exact <br> counts for spacing).
    // Only collapse runs of <br>s in flow content where 3+ in a row is
    // almost always Outlook reply-template noise.
    if ($(br).parents("table").length > 0) return;
    let cur: any = br;
    let keep = 1;
    while (true) {
      let next: any = cur.next;
      while (next && next.type === "text" && !(next.data ?? "").trim()) {
        next = next.next;
      }
      if (!next || next.type !== "tag" || next.name !== "br") break;
      keep++;
      const toRemove = next;
      cur = next;
      if (keep > 2) $(toRemove).remove();
    }
  });

  return body.html() ?? html;
}

export function preprocessEmailBody(
  bodyHtml: string | undefined,
  bodyText: string | undefined,
  subject?: string,
): PreprocessedBody {
  const isForwarded = isForwardedEmail(bodyHtml ?? "", bodyText ?? "", subject);

  if (!bodyHtml || !bodyHtml.trim()) {
    return {
      bodyHtmlClean: undefined,
      bodyHtmlTrimmed: undefined,
      hasQuotedHistory: false,
      isForwarded,
    };
  }

  // Sanitize first — the rest of the pipeline assumes safe HTML.
  let clean: string;
  try {
    clean = sanitizeHtml(bodyHtml, SANITIZE_OPTS);
  } catch {
    // Fall back to original if sanitize-html chokes on malformed markup.
    return {
      bodyHtmlClean: undefined,
      bodyHtmlTrimmed: undefined,
      hasQuotedHistory: false,
      isForwarded,
    };
  }

  // Strip quoted history.
  let trimmedHtml = clean;
  let hasQuoted = false;
  try {
    const stripped = stripQuoted(clean);
    trimmedHtml = stripped.body;
    hasQuoted = stripped.hasQuoted;
  } catch {
    // jsdom failure — keep clean as the trimmed version.
  }

  // No whitespace mutation. Gmail / Spark / Outlook all render the email's
  // HTML verbatim; trimming <br> runs and empty blocks broke author-intended
  // spacing for legitimate signatures and marketing layouts.
  // (trimWhitespaceServer kept in module for any future opt-in callers.)

  return {
    bodyHtmlClean: clean,
    bodyHtmlTrimmed: trimmedHtml,
    hasQuotedHistory: hasQuoted,
    isForwarded,
  };
}
