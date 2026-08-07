# Review: clientsite — 2026-07-25
**Overall 5/10** · 1 blocking · 1 should-fix · 1 nitpick
Reviewed at 1440×900. See calibration.md for how this reviewer's ratings
map to real examples, and annotations.json for machine-readable data.

## Global notes
- Every button is too round. Cap border-radius at 6px sitewide. _(should-fix)_

---

## [BLOCKING] section.hero > h1.display — 3/10 · typography
**Selector:** `section.hero > h1.display`
**Fallback:** `body > div:nth-child(2) > section:nth-child(1) > h1`
**File:** index.html:47 · **Viewport:** 1440×900 (desktop)
**Screenshots:** shots/ann_a1b2c3d4_el.png · context: shots/ann_a1b2c3d4_ctx.png

**Current styles**
Inter, sans-serif 400 · 42px/48px · letter-spacing 0px · color #6b7280 · background transparent · margin 0px 0px 16px 0px · padding 0px · display block

**Why it's wrong**
Reads like body copy. No weight contrast against the subhead, and the gray kills it against white.

**What I want**
Heavier, larger, near-black. More authority.

**Reference:** collection.industries — `header h1`
Söhne 600 · 72px/76px · letter-spacing -0.02em · color #111111

---

## [SHOULD-FIX] .pricing .card — 6/10 · spacing, layout
**Selector:** `.pricing .card`
**Fallback:** `body > main > section:nth-child(4) > div > div:nth-child(1)`
**File:** index.html:112 · **Viewport:** 1440×900 (desktop)
**Screenshots:** shots/ann_e5f6a7b8_el.png · context: shots/ann_e5f6a7b8_ctx.png

**Current styles**
Inter, sans-serif 400 · 15px/22px · color #1a1a1a · background #f8f8f8 · margin 0px · padding 16px · display flex

**Why it's wrong**
Cards are cramped — 16px padding forces the price against the border, and the three cards read as one gray slab.

**What I want**
At least 32px padding, visible gap between cards, let the recommended tier breathe.

---

## [NITPICK] footer p.legal — 7/10 · copy
**Selector:** `footer p.legal`
**Fallback:** `body > footer > p:nth-child(3)`
**File:** index.html:203 · **Viewport:** 1440×900 (desktop)
**Screenshots:** shots/ann_c9d0e1f2_el.png · context: shots/ann_c9d0e1f2_ctx.png

**Current styles**
Inter, sans-serif 400 · 12px/18px · color #9ca3af · background transparent · margin 24px 0px 0px 0px · padding 0px · display block

**Why it's wrong**
"© 2024" is stale and the company name is spelled two different ways on this page.

**What I want**
Current year, one canonical spelling.

## Resolved this review
- `nav .cta` (4 → 8) — before shots/ann_b3c4d5e6_el.png → after shots/ann_b3c4d5e6_after_el.png · 41% of pixels changed — fixer's note: switched to the solid button style
- `.hero img` — before shots/ann_f7a8b9c0_el.png → after shots/ann_f7a8b9c0_after_el.png · verified: nothing changed visually
