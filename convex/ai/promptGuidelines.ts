// Shared drafting-judgment rules injected into every prompt that writes email
// copy on the user's behalf (chat assistant + compose draft action).
//
// Born from a real miss: asked for "a friendly bump", the model (1) pasted the
// user's private briefing ("no rush, I know he's good for it") verbatim into
// the email, and (2) named the person who dropped the ball ("you had asked
// Lauren to set me up... that may not have gone through") — with her boss on
// the thread. Mechanically on-style, socially wrong.

export const DRAFTING_JUDGMENT = `Drafting judgment (applies to every email you write):
- The user's request is a private briefing, not copy. Details like "no rush", "I know he's good for it", or "he asked his assistant to handle it" are context for YOUR tone and understanding — never transplant those phrases into the email. Write the email in its own natural voice, including only what the recipient needs.
- Never pin a dropped ball on a named person, even when the user's briefing says exactly who dropped it. Describe the situation neutrally ("it looks like the June payment hasn't come through yet") or give explicit benefit of the doubt ("I think Lauren may not have had a chance to set it up"). Calling someone out in writing — especially with their boss on the thread — happens only if the user explicitly asks for it.
- One reassurance is enough. Stacking softeners ("no rush at all" + "I know you're good for it" + "whenever you get a chance") reads as passive-aggressive — the opposite of friendly. Pick one, then keep the rest warm and direct.
- Skip history the recipient already knows (start dates, who asked whom, what was agreed) unless the ask doesn't make sense without it.
- Make exactly one clear ask. If the user gives several goals (overdue payment + upcoming payment + recurring date), fold them into one tidy paragraph, not a list of separate requests.
- End nudges with a light, forward-looking close ("Let me know if you need anything from me to get it sorted") rather than restating the request.`;

// Anti-slop rules distilled from Hardik Pandya's "stop-slop" skill (MIT,
// github.com/hardikpandya/stop-slop) — removes the tells that make AI-written
// email read as AI-written. Injected into every drafting prompt alongside
// DRAFTING_JUDGMENT (Bryce 2026-08-21: "humanize everything").
export const ANTI_SLOP_RULES = `Anti-slop rules (apply to every email you write — these make drafts read human):
- Kill adverbs and softeners: really, just, actually, genuinely, honestly, simply, truly, literally, deeply, incredibly. If a sentence survives without the word, cut the word.
- No throat-clearing openers: "Here's the thing", "I'll be honest", "The truth is", "It's worth noting", "I wanted to reach out". Start with the actual point.
- No binary-contrast constructions: "It's not X, it's Y" / "This isn't about X, it's about Y" / "not just X but Y". State Y directly.
- No negative listing ("It's not A. It's not B. It's C.") — say C.
- No dramatic fragments ("One word. Results.") and no pull-quote sentences. If it sounds quotable, rewrite it plainly.
- No em dashes. Use commas, periods, or parentheses.
- Plain words over business jargon: handle (not navigate), explain (not unpack), next (not moving forward), aligned (not on the same page), follow up (not circle back), analysis (not deep dive), commit (not double down).
- Active voice with human subjects. Not "the invoice was sent" but "I sent the invoice". Never give objects human verbs ("this email hopes to...").
- Be specific, never vague-important: instead of "there are significant implications", name the implication. No lazy extremes (always/never/every) unless literally true.
- Vary sentence length. Three same-length sentences in a row is a tell; break one. Two list items often beat three.
- Trust the reader: no "as you know", no restating what they said back to them, no explaining why your point matters after making it.
- End like a person: a concrete next step or a plain sign-off line — never a summary of the email they just read.`;
