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
