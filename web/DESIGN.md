# ZecDrop interface: design plan

Owner feedback (2026-10-08): the current UI is ugly, wordy, hard to navigate and discouraging. It must be dynamic and
interactive, with better screens. This plan replaces the presentation layer. API clients, schemas, stores, the
privacy rules and the tests of behaviour stay; page layouts, copy and their copy-pinned tests are rewritten.

## Who and what

A person who has to pay many people and keep amounts private (a DAO treasurer, a small payroll, a grant program). Not a
cryptographer. Their job: get a list of payouts sent with confidence, then show it happened. Public visitors (judges,
recipients) job: understand in ten seconds what this proves, then check it.

## The one memorable idea: the redaction lens

The product *is* the difference between what different people can see. So the interface shows it instead of explaining it.
Any payout list can be viewed through three lenses, switched with one control:

- **Public**: names, addresses and amounts are black redaction bars; only the count, total and fee are readable.
- **Recipient**: one row revealed (pick who), the rest stay black.
- **Auditor**: everything revealed.

Bars animate away/back (a short wipe) when the lens changes. It appears in three places: the home hero (sample list), the
Check stage of the operator flow (the real in-memory list), and the public receipt (always public lens, with a note on
what the auditor lens would show). It replaces most explanatory paragraphs. Everything around it stays quiet.

## Tokens

The look is **Midnight** (the owner's choice, 2026-10-08: "Midnight, Lively"). A deep indigo page, an electric-violet
action, a teal second colour. Every colour is a role in `src/index.css` (`--p-*`), nothing in `src/` names one, and
`src/colours.test.ts` computes the contrast of every pair of roles that meet in the app (text 4.5:1; a control's boundary
and the ends of the gradient 3:1) and fails on a colour literal anywhere else.

- Midnight, dark (the default): bg `#0B0B1A`, surface `#15152E`, ink `#F1F1FF`, muted `#9A9AC4`, rule `#2A2A52`, accent
  (electric violet) `#7658FF` with white ink on it (the lab's `#7C5CFF` is 4.35:1 against white; a hair deeper reaches
  4.56:1), accent-2 (teal) `#2EE6D6`, bar `#2A2A52` with a faint diagonal hatch, good `#2EE6D6`, bad `#FF8A9B`.
- Midnight, light (for people who switch, or whose system says light): the same family on a pale lavender-white: bg
  `#F6F6FF`, surface `#FFFFFF`, ink `#12122A`, accent `#6A4CFF` (white ink, 5.1:1), accent-2 `#00877D` (the suggested
  `#00A99D` is 2.7:1 on the page; this is 4.1:1, which the gradient's end needs), bar `#12122A`.
- The default is dark; with nothing chosen, a system that says light gets the light set. There are no palette choices.
- Accent: the one action, the revealed state, focus. The accent-to-accent-2 gradient is used on text **once per page** (one
  emphasised word group: "private" on the home page) and as the logo dot and the receipt's flow line; nowhere else. A soft
  glow of the two behind the page drifts slowly when Lively and is not drawn otherwise.
- Type: **Schibsted Grotesk** (variable, self-hosted via `@fontsource-variable/schibsted-grotesk`) for everything, with
  display weight 700 and tight tracking for big numbers; **IBM Plex Mono** (`@fontsource/ibm-plex-mono`) only for ids,
  addresses and amount columns (tabular figures). Scale 14 / 16 / 20 / 28 / 44 / 72. Body line length at most 64
  characters. Left aligned everywhere. No third-party font requests (CSP stays `'self'`): bundle the files; record
  package names, versions and licences (OFL) in `PROVENANCE.md`.
- Shape: soft corners (14px) on controls and pills for choices; **no card grid**. Structure comes from spacing, hairline rules and
  large type, not from boxes around everything. Rows are ruled lines, not tiles.
- Motion: **Lively** is the default, **Calm** is the other choice (kept in localStorage), and the system's
  `prefers-reduced-motion` forces Calm and switches every animation off (no confetti, no glow). Allowed: the lens wipe
  (bars lift and return in a stagger), numbers counting to their value, rows sliding in, accordions opening, the receipt's
  flow line drawing itself, the sending timeline advancing, the sealed stamp with a short confetti burst, button press and
  hover feedback, a sliding thumb on every segmented control, toasts. Not allowed: entrance fades on every section.

## Self-critique of the plan (done before building)

- Looked like the generic defaults? The first look (cool paper, ink, a yellow highlighter) was calm but the owner found it
  flat and not interactive; Midnight with real motion replaced it. What stays specific is the redaction lens and the plain
  words; the colour and the motion carry the energy.
- SaaS card kit? Rejected: ruled rows and whitespace, no identical rounded cards.
- Template chrome? No tracked-caps eyebrows above headings, no middle-dot meta strings, no "→" suffixes, no numbered
  markers except the real 3-stage sequence.
- One accent of boldness: the lens. Everything else is typographic restraint.

## Flow (operator): 3 stages, one page, no five-step wizard

```
 ZecDrop                                  [ New payout ]    (mock/testnet pill)  (theme)

 Payouts ──── Check ──── Send            ← slim 3-segment tracker; the only numbered thing
```

**Stage 1, Payouts.** A big drop zone ("Drop a CSV here, or paste it"). After a file/paste: a ruled table (address short,
amount, memo), live total counting up, per-row problems inline in the row ("Line 4: amount has too many decimals"),
never echoing full addresses in errors. Name field ("Name this payout run", optional default "Payout, 8 Oct"). A closed
"Options" disclosure holds fee level and payouts per batch with good defaults. Primary: **Continue**.

**Stage 2, Check.** Left, huge: `8 people  0.005 TAZ  + 0.00045 fee`. Under it the lens switch + the list. Warnings are
short chips ("Only 3 people: amounts are easy to guess") each with a "Why?" popover. Time estimate as one line ("About 20
seconds"). Primary: **Looks right, continue**. Secondary: back.

**Stage 3, Send.** One question first: *Is it funded?* Shows the funding address with a copy button (and QR only if a
dependency-free renderer is trivial; otherwise skip) and a live "Waiting for funds" pulse that flips to "Funded" the
moment the operator sees it. Then **Send 8 payouts**, which opens a confirm sheet ("This sends 8 payouts, 0.005 TAZ plus
0.00045 fee. It cannot be undone."). After confirming, the sheet becomes a live timeline: Preparing, Proving, Sending,
Confirming 1 / 2 / 3, Done, with elapsed time and a realistic estimate; failures say what happened and what to do. On
Done: the sealed stamp, then three big actions: **Open public receipt**, **Copy receipt link**, **Give an auditor access**
(the existing irreversible-disclosure confirmation stays). "Fund from another coin" (NEAR) is a collapsed row under the
address, not a section: closed, it asks the price service nothing. On a testnet campaign it opens to a price preview (NEAR
delivers mainnet ZEC only; it creates nothing). On a mainnet campaign it takes the funder's refund address, shows a price quote
(still nothing created), and asks for its own "I understand" before the deposit address. The operator keeps that address, so
closing the row or reloading shows it again. A swap's success is "paid to the deposit address, says the service"; the campaign
is funded only when the operator sees the coin on chain.

**Campaigns page.** Empty: a heading, one friendly sentence, three bars that stand for rows (decoration, hidden from assistive
technology, no text) and the drop zone as the call to action. The same bars and a primary "Start a payout" are the empty state
of the audit page; a payout with no batches says "No batches yet" and when they appear. Non-empty: ruled rows (name, people,
total, status dot, time), whole row clickable, "New payout" button top right.

**Mock-chain banner**: a slim fixed pill in the header ("Practice mode: nothing is sent to Zcash"), not a full-width
bar that can overlap content (it overlapped the stepper and the title in screenshots).

## Public pages

**Home.** Headline "Pay many people. Keep who got what private. Prove the total." Under it the lens demo on the real
8-payout sample list (rows labelled Person 1..8; amounts from the public sample CSV), with the lens switch as the hero
interaction. Two buttons: *See a real receipt* and *How it works*. Three short lines (what is public / hidden / checkable)
and the one-sentence testnet status. No paragraphs of explanation above the fold.

**Receipt.** A verdict line first ("Settled. 8 payouts, 0.005 TAZ, fee 0.00045"), a single funds-flow strip (Funded,
Private pool, 8 outputs), the lens (public, with the note), then collapsed accordions: Transaction, Funding address, List
fingerprint, "What this proves and what it doesn't" (two short lists of three items each at most, wording from
docs/PRIVACY_BOUNDARY.md, banned phrases still enforced). Findings keep the Rust-sourced sentences, shown inside the
verdict area and in details.

## Copy rules (hard)

- Sentence case. One short sentence per element, at most about 12 words for helper text. Long explanations go in a
  "?" popover or an accordion, never inline.
- Plain words on primary surfaces: "people" not recipients, "total" not declared total, "network fee", "list fingerprint"
  not manifest commitment, "private pool" at most once with a "?"; no "zatoshi", "ZIP-317", "Ironwood", "manifest" outside
  details. Technical names stay available in details and tooltips, so nothing honest is hidden.
- Buttons are verbs that say what happens ("Send 8 payouts", "Copy receipt link"); the same action keeps the same name
  everywhere. Errors say what went wrong and what to do; no apologies, no vague text.
- Keep every honesty rule: testnet coins have no value (TAZ vs ZEC), "funded only when seen on chain", NEAR success is not
  funding, banned-phrase tests stay, and the Rust-sourced sentences (findings, phases, warnings) stay word for word wherever
  they appear.

## Non-negotiables carried over

Recipient data in memory only (never storage, URLs, console, or any request except the create call); the token in memory
only; no third-party requests; CSP intact; axe clean at 360px and 1280px in the dark and the light set; full keyboard path with visible
focus (ink outline + an accent ring); touch targets at least 44px; no layout shift when numbers count up (tabular figures).

## Delivery in stages (screenshots at each stage, saved under the scratchpad `ui-shots/`)

A. Design system (tokens, fonts, buttons, rows, popover, accordion, lens component, tracker) and the operator shell, the
   Campaigns page and Stage 1. B. Stages 2 and 3, the sending timeline, the sealed done state, the audit page. C. Home and
   Receipt, then the NEAR row. After each stage: lint, typecheck, unit, build, e2e, axe; update copy-pinned tests to the new
   words (do not weaken them); screenshots at 1280 and 360 in light and dark.

## Interactions (built, each keyboard-operable with a visible focus ring and announced where it changes)

Sliding-thumb segmented controls (the lens, mode, motion); bars that lift and return in a stagger, with the text of a
hidden cell still absent from the page; row hover tint; counts that run to their new value; a drop zone that takes the accent
under a dragged file, and rows that slide in; an inline problem in the row of an amount that cannot be read, with the total
following; accordions that open without a jump; the receipt's flow line drawing itself when scrolled into view; a confirm sheet
(the browser's own modal `<dialog>`: the usual library's scroll lock adds a `<style>` element the operator's CSP refuses); a
live sending timeline with a progress bar and an elapsed clock; the stamp and confetti; toasts for copy actions.

## Watching the motion on the live path

`e2e/operator/motion-shots.spec.ts` (needs `UI_SHOTS_DIR`) runs the real operator on the mock chain, slowed with
`ZECDROP_E2E_POLL_MS` and `ZECDROP_E2E_CONFIRM_POLLS`. The mock chain climbs from the first to the last confirmation in
milliseconds, so "Confirming 2" and "3" are shown from the real campaign with only its batch states changed (`stepped-*`); the
lens wipe and the stamp are real animations moved to stated fractions (`seek-*`); the count-up runs on Playwright's clock.

## Header

One line on a phone (name, a Menu button or the two operator links, the settings); the state of the chain on a quiet line of
its own under it; the one button ("New payout") in the first line on a wide screen.
