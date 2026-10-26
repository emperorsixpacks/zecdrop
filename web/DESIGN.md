# ZecDrop interface: design plan

Owner feedback (2026-10-08): the current UI is ugly, wordy, hard to navigate and discouraging. It must be dynamic and
interactive, with better screens. This plan replaces the presentation layer. API clients, schemas, stores, the
privacy rules and the tests of behaviour stay; page layouts, copy and their copy-pinned tests are rewritten.

Owner feedback (2026-10-19): the UI is "just okay": make it more pleasing and more responsive to touch, let "the edges of the screen"
be curved "so the notch can be felt", and the get-paid page is too wordy. Answered by "The screen" (below), the get-paid page's
rewrite, and the header's new offset. The identity is unchanged: paper, ink, the marker, redaction bars, the big tight grotesque.

Owner feedback (2026-10-20): "the UI is fine but we need a cool landing page"; the home page read as documentation, not as a
landing page. Answered by "Home" (below): the headline beside the sheet, with one first look on it (the bars are drawn while the
total counts up), a band across the screen in the bar's own colours, the real run printed as a till receipt, a section for the
people being paid, and the steps, practice mode and tour kept. No new colour, font or claim.

Owner feedback (2026-10-20, later): no yellow highlighting on the writing; the text is plain ink ("complete black"). So nothing is
highlighted behind text anywhere: a revealed address, amount or memo in the lens is plain text where its bar was, the row of the one
person revealed takes the neutral tint of a row, and the home page's three public figures are plain. The marker yellow stays where it
is not on the writing: the action in the dark set, the focus ring, the capsule's *Mainnet* chip and current page.

Owner feedback (2026-10-15): wanted something cleaner and better looking. Direction chosen: **Redacted paper** (light by
default, black redaction bars, one marker-yellow accent, no gradients or glow), public pages and the shared tokens first; the
operator screens inherit the tokens and get their own pass after. The structure, flow, copy rules and tests below are unchanged.

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

The look is **Redacted paper** (the owner's choice, 2026-10-15, replacing Midnight): a document on a desk. Every colour is a
role in `src/index.css` (`--p-*`), nothing in `src/` names one, and `src/colours.test.ts` computes the contrast of every pair
of roles that meet in the app (text 4.5:1; a control's boundary 3:1) and fails on a colour literal anywhere else.

- Light (the default): desk `#F3F3F0`, sheet `#FFFFFF`, ink `#141414`, muted `#595954`, rule `#DAD9D3`, action `#141414`
  with white ink, redaction bar `#000000`, marker `#FFD60A` (with ink `#141414` on it), good `#0B6B3A`, bad `#B3261E`.
- Dark (after hours; chosen by the person, or by a system that says dark): desk `#121212`, sheet `#1B1B1B`, ink `#F2F2EE`,
  muted `#A1A19B`, rule `#333330`, bar `#C9C9C2`, good `#4ADE80`, bad `#FF8A8A`. Black would vanish on this page, so the
  **action is the marker** (`#FFD60A`, ink `#141414` on it).
- The **marker** is where focus is (an ink outline with a marker ring), where you are in the header capsule, and the word
  *Mainnet* on it. It is never drawn behind writing (owner, 2026-10-20): what the lens reveals is plain text where the bar was.
  It is not used for decoration.
  No gradient anywhere, no glow, no hatching on bars.
- The **header capsule** is the redaction bar, so its fill (`--p-island`) is the bar's, in both sets. Its text (`--p-island-ink`) is
  `#F2F2EE` on the black bar and `#141414` on the dark set's light grey; its quieter text (`--p-island-muted`) is `#A1A19B` and
  `#3D3D38`. `src/colours.test.ts` holds all three to contrast, and holds the fill equal to the bar.
- Type: **Archivo** (variable, with its width axis, self-hosted via `@fontsource-variable/archivo/wdth.css`) for everything;
  headlines and big numbers are weight 800 at 88% width with tight tracking (`.display`). **IBM Plex Mono**
  (`@fontsource/ibm-plex-mono`) only for ids, addresses and amount columns (tabular figures). Scale 14 / 16 / 20 / 28 / 44 / up
  to 80. Body line length at most 64 characters. Left aligned everywhere. No third-party font requests (CSP stays
  `'self'`): bundle the files; record package names, versions and licences (OFL) in `PROVENANCE.md`.
- Shape: one scale of curves, cut from the screen's own corner down to the smallest chip (see "The screen"): pills for buttons,
  chips and segmented controls, 20px slips of paper for cards, 14px for fields, 2px for redaction bars (they are
  strokes, not objects). One white **sheet** holds the lens on the home page; elsewhere structure comes from
  spacing, hairline rules and large type, and a step or a result sits on a slip. Rows are ruled lines.
- The mark: the logo is a small redaction bar next to the name.
- Motion: **Lively** is the default, **Calm** is the other choice (kept in localStorage), and the system's
  `prefers-reduced-motion` forces Calm and switches every animation off (no confetti). Allowed: the lens wipe (bars lift and
  return in a stagger), numbers counting to their value, rows sliding in, accordions opening, the receipt's flow line drawing
  itself, the sending timeline advancing, the sealed stamp with a short confetti burst, button press feedback, a sliding thumb
  on every segmented control, toasts, the header capsule's morph when it is opened or closed, the press response of everything
  that can be pressed, a redaction bar's label on touch, and a new page's cross-fade. Not allowed: entrance fades on every
  section, a background glow, anything that moves while the page loads or scrolls, anything that moves by itself. One exception
  (2026-10-20): the home page's **first look**, Lively only and once a visit, about two seconds, then still (see "Home").

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

**Stage 3, Send.** One question first: *Is it funded?* Shows the funding address with a copy button, an Open in wallet link and a QR code of the
same wallet link (REQ-FUND-003; see "QR codes") and a live "Waiting for funds" pulse that flips to "Funded" the
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
total, status dot, time), whole row clickable, "New payout" the round action at the end of the header capsule.

**Mock-chain line**: a slim hatched pill on a quiet line of its own directly under the header capsule ("Practice mode: nothing
is sent to Zcash"), in the page's flow, not a full-width bar that can overlap content (it overlapped the stepper and the title
in screenshots). It is a `role="status"`, as is "Chain mode unknown: practice controls hidden" beside it.

## Public pages

**Home** is the landing page (owner, 2026-10-20). In order:

1. **The headline and the sheet**, side by side on a wide screen so the first look is seen without a scroll (stacked on a phone).
   Left: "Pay many people. Keep who got what private. Prove the total." in the big grotesque pushed further (weight 800, width
   72%, up to 92px), the one-sentence testnet status, two buttons (*See a real receipt*, filled; *Try a practice payout*, outline)
   and two text links (*How privacy works*, *Being paid? Start here*). Right: the one white sheet, *Same payout, three views*,
   with the real transaction's short id, the count, total and fee in plain ink (what anyone can read; the bars are what they
   cannot), and the lens on the real 8-payout sample list (Person 1..8), its switch under the list so
   that the tab order runs down the page (the buttons beside the sheet come first; `e2e/keyboard.spec.ts` holds it).
2. **The first look** (Lively, once a visit): the sixteen bars wipe in row after row over cells that never held any text,
   while the total counts up; about a second, then still. In Calm,
   under reduced motion and on a return to the page it is not played: the sheet is simply there. It is the page's one
   unprompted motion; nothing else on the page moves by itself.
3. **The band**: the redaction bar itself across the whole screen (the header capsule's fill and ink, so black with light text,
   and in the dark set the light-grey bar with dark text), headed "Private amounts, public accountability.", with *Public*,
   *Hidden* and *Checkable* in very large type over their short lines.
4. **It ran on public testnet**: three short lines and *Open the receipt*, beside the real run printed as a till receipt (the
   torn sheet, mono, dotted leaders, tilted a degree on a wide screen): payouts, transaction, total, fee, block, time to settle;
   then the limits measured offline (330 in one transaction, 142 s to prove it, 0.52 s to check it); ending "No mainnet payout
   yet." Every figure is the real receipt's or is named in `src/features/home/run-facts.ts` with its source.
5. **How to run a payout** (the four steps, unchanged), then **Try it yourself** on a slip (the button beside the text on a wide
   screen), then **For the people you pay** (the get-paid page and payslips, one line each), then the tour.

No paragraph is longer than a short sentence (a test holds them to 16 words), and no part claims more than the status line.

**Receipt.** One white **sheet** with an ink rule on top and a torn bottom edge (`.receipt-sheet`, a mask). On the left a
verdict line first ("Settled. 8 payouts, 0.005 TAZ, fee 0.00045"), then what the verifier found, then the funds flow as three
stations down a line, like the lines of a receipt (Funded from, Private pool, 8 outputs); on the right the lens (public, with
the note). On a phone it is one column, with dashed perforations between the parts. Below the sheet, on the desk, collapsed accordions: Transaction, Funding address, List
fingerprint, "What this proves and what it doesn't" (two short lists of three items each at most, wording from
docs/PRIVACY_BOUNDARY.md, banned phrases still enforced). Findings keep the Rust-sourced sentences, shown inside the
verdict area and in details.

**Payslip.** One column, like the privacy page. Above the button, in this order: the box (label, one line of help), the note that
checking shares the payslip with whoever runs the verifier (a ruled note with the marker's rule, read before the button), then
Check payslip and Clear; the two helpers (a sample, and a changed copy to watch fail) sit under a hairline with one line
saying the sample is the real testnet batch's payslip 3. The result is one sheet with an ink rule on top, like a receipt
without the torn edge: the verdict in large type (a drawn tick and the good colour for Verified, the bad colour for
Not verified), one or two sentences, then ruled rows (the amount and a short receiver, labelled as what the payslip states,
the transaction with its explorer link, the action, the confirmations). It is in a polite live region and takes the focus.
"What this does not prove" is always the last block, whatever happened above it. A check that gets no answer is a calm
notice, never the bad colour: it says nothing about the payslip.

After the two helpers and before the result, only when the box holds a payslip that reads as one: **Send this payslip**, a section
under a hairline. First
the warning, a ruled note with the marker's rule, always there and read before any button ("This link holds the whole
payslip. Anyone who gets it can read its amount, its receiver and the key to its memo, and can present it as their own. Send it only
to the person you want to prove the payment to."). Then up to three secondary buttons, Make a link, Show QR code and (only where the
phone has a share sheet) Share; the first two toggle and say what they will do next. The link is a read-only box that selects itself
on focus, in the mono face and breaking anywhere, with Copy payslip link under it; the QR code is the width of the column on a phone
(at most 26rem) and four pixels a module from 48rem up. A page opened from a link has a ruled note above the box that says the
payslip came from a link and who therefore has it; the address bar is already bare by then, and the page has not checked anything.
A link that is not a payslip is one plain sentence above the box, in the problem colour, and nothing is loaded.

**Get paid.** For a recipient on a phone, and short (the owner found the first version wordy, 2026-10-19: it was 376 words and is now
under 240, which `GetPaidPage.test.tsx` keeps as a ceiling). A promise in one line of larger type ("To be paid privately, get a shielded
wallet and give the payer one address."), and under it, small, what the page does not do (ZecDrop never sees the wallet; nothing leaves the
phone unless it is shared). Then four numbered steps, each on a **slip** (one column on a phone, two by two from 64rem up): Get a wallet,
Copy your address, Give it to your payer, When you are paid. The number is a small ink circle (the marker in the dark set), drawn and not
read, level with its title. Step 1 says what the page claims of the wallet and where that comes from ("By its release notes, version 3.8.0 or
newer supports the shielded pool that payouts use"), has the one link out, and keeps the rest (what *shielded* means, that other wallets
have not been checked, and what happens in a wallet that cannot receive in the current pool) behind one closed row, *More about wallets*,
as the copy rules below ask of a long explanation. Step 2 says where to find the u1 address and gives the other kinds a wallet may show as
three short rows (how it starts, what to do about it: `utest1`, `t1 or t3`, `zs1`). Step 3 is the box: a line that says the check is of
shape only, the result as a ruled note (the ink rule for a real-money address, the marker's rule for a practice, Sapling or unrecognised
one, the bad colour for the one that would publish every payment), Share and Copy, and the line that says when they turn on. Share is the
main button where the phone has a share sheet, Copy where it has none. There is no picture, no third-party font and no link out but the
wallet's.

## QR codes

Two of them, and one component (`QrCode`): the funding request and a payslip link. A scanner reads dark on light, so the code is black
on white in every theme (the roles `--qr-ink` and `--qr-paper`, black and white in the light set and in the dark set,
held there by `colours.test.ts`), on a white sheet with four modules of quiet zone, whatever the page around it. It is an inline SVG
with one `rect` and one `path`, named for a screen reader ("QR code for this deposit", "QR code of the payslip link"), and has a caption
that says what scanning it does, in the text and not only in the picture. It is not recoloured by forced-colours. The funding code shows at md and
up beside the address it belongs to, and below that behind a button, because a phone cannot scan itself; a payslip's is behind its button at every width. Where there is room a module
is a whole number of pixels (five for the funding code, four for the longer payslip link); on a phone the code fills its box.
Until the library is loaded a dashed square in its place says the code is being made, and a code that cannot be made says so.

## Practice mode

The operator's own screens against a simulation in the page, so that anyone can try a whole payout on a phone (REQ-DEMO-001). The
design rule is that it can never be taken for a real payout, and that nothing about it is quiet:

- **The banner**, at the very top of every screen, above the header, in the page's frame, so that no screen can be drawn without it.
  A full-width band with the faint diagonal hatching that already means "not real" (the practice chain's pill), a hairline under it,
  the sentence in one paragraph in the body size ("Practice mode: everything here is simulated in your browser. No real money,
  nothing is sent anywhere, nothing is saved. Reloading starts over.") and one outline button, *Leave practice mode*, beside it on a wide screen and
  under it on a phone. It is not dismissed, collapsed or shortened, and it is a labelled region of its own, so a screen reader finds
  it. It is not sticky (the header capsule is, and it sits below the banner, which scrolls away while the capsule stays), and on a
  phone it is three lines and a button.
- **The header** names no network: a hatched outline chip, *Practice*, stands on the capsule where "testnet" or "Mainnet" would
  be, on every screen and without opening anything; the open panel says "Practice, nothing is real" where it would say "Zcash
  testnet". The operator's practice-chain line is not shown beside it: one statement is enough.
- **Amounts** are TAZ, as on any testnet page, and no practice screen says ZEC.
- **Ids.** A simulated id begins with the ASCII of "practice" in hex, and where a real id has an *Explorer* link a practice id says
  "Practice id: on no chain, so no explorer". The receipt's heading line says "Practice id:" before the campaign's id, and a quiet note
  (the information notice, a rule on the left) says in two sentences that this receipt was made in the page from the simulated payout
  and that no explorer can find its ids. The funding address says a practice payout has none, instead of "unknown to the verifier".
- **The example list** is the main button of the drop zone, before *Choose a file* and *or paste it*, on the payouts screen and on the
  empty payouts list. The list is the repository's own public sample (the one the home page's lens shows).
- **The operator's own sentences** that would be untrue of a pretended run say so, and only in practice mode: the timeline's
  "Sending to the network." is "Pretending to send: nothing leaves your browser.", its "Waiting for the next block." is "(simulated)", the
  activity log's "sent to the network" is "pretend-sent (practice)", and the send sheet's "It cannot be undone." is "In a real run this
  cannot be undone." (above its own line, "Practice mode: nothing is sent anywhere. This only simulates it.", because the sheet covers
  the banner on a phone that has scrolled). Off, they are the operator's words.
- **Where it does not apply**, it says so: a payslip and a receipt link that practice mode did not make get a calm notice
  (*Practice mode does not check payslips*, *Practice mode does not read the chain*), as a verifier that cannot be asked would give.

## No wallet to connect

ZecDrop has no "connect wallet" button on purpose: the operator on the person's own computer holds the keys (ADR 0002), and the
hosted site only views and checks receipts. Two things make that clear and easy, neither of which touches the key rules:

- The home page has a four-step "How to run a payout" that says so in one sentence.
- The funding step has **Open in wallet**: a `zcash:<address>?amount=<ZEC>` link (ZIP-321, `src/lib/payment-uri.ts`) that opens
  a wallet app with the address and amount filled in. It carries no memo and nothing about the payout, it is not shown if the
  address or amount fails its check, and the page says what to do when no wallet app handles the link (copy the address). Whether
  a given wallet app opens it, on testnet in particular, is **not verified**. Funding is still only "funded" when the operator
  sees the coin on chain.

A real wallet connection (a wallet signing the batch) would change how batches are signed (AGENTS.md invariants 1 to 4) and needs
an OpenSpec change first. It is not built.

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
only; no third-party requests; CSP intact; axe clean at 360px and 1280px in the dark and the light set (and on the operator's pages at 320px); nothing wider than the screen from
320px up (see "Narrow screens" under The screen); full keyboard path with visible focus (ink outline + an accent ring); touch targets at least
44px (the capsule's *New payout* is 36px and has an invisible 4px margin all round); no layout shift when numbers count up (tabular figures).

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

## Header: one capsule

The owner asked for a notch, like the iPhone's Dynamic Island, in place of a full-width navbar (2026-10-19). The header is one
capsule floating at the top centre of the page, and it is the site's own **redaction bar**: its fill is the `bar` colour (black in
the light set, the light grey in the dark set, where black would vanish), its text is light on it (dark on the grey), and the page
you are on is marked with the **marker**, the way the lens marks what has been revealed. It is the one bold thing in the app, in
one place, and everything around it stays quiet: a solid shape, no blur, no gradient, no soft shadow, no border in the dark set
(the grey is enough against the page).

- **Closed** (the default) it is one 44px button, as wide as what it holds: the mark (the logo's bar, in the capsule's ink), the
  word ZecDrop, a hairline, the name of the page, a small chevron, and the network. Page names: Home, Receipt, Get paid, Payslip,
  How privacy works; on the operator's side Payouts, New payout, Payout, Audit; the site's own name on a page that has none (said
  once), and on a hosted copy for an operator address, which shows a notice and not the page (`src/lib/page-name.ts`). The network is
  on the capsule at all times, so the thing that most needs to be known is never behind a press: quiet text *testnet*, a
  marker-yellow chip *Mainnet*, a hatched chip *Practice*. Below 24rem the word ZecDrop gives way first and stays in the button's
  name; "How privacy works", the longest name, fits whole from 320px up. The chevron is the one addition to the brief's list: a black
  pill that does not look pressable is not found.
- **Open** (a press, Enter or Space) it morphs in about 350ms (`cubic-bezier(0.32, 0.72, 0, 1)`) into a panel up to 34rem wide with a
  28px radius, anchored at the same place: the links as rows at least 44px tall, with the current page's label on the marker, in
  heavier type (so it does not rest on a colour alone) and `aria-current="page"`, and a footer row with the network in full ("Zcash
  testnet", "Zcash mainnet"), the theme button and the appearance panel. It lies over the page and moves nothing, so opening it
  never shifts what is under it. Escape, a press outside it, choosing a link, a new page (the back button too) and the focus leaving
  it close it. Escape and choosing a link give the focus back to the capsule, and Escape inside the appearance panel closes only
  that panel. Hovering gives the capsule a tint and nothing more: a phone has no hover, so nothing may depend on it.
- **One button.** The whole closed capsule is a single `<button>` with `aria-expanded` and `aria-controls`, and its name is what it
  shows ("ZecDrop Home testnet"): no label of its own that could say something else. The panel is `inert` and `visibility: hidden`
  while closed, so its links are out of the tab order and out of the accessibility tree (jsdom cannot tell, so `e2e/island.spec.ts`
  asks the browser's own accessibility tree). The skip link is still the first stop; the capsule is the second.
- **The operator's side.** "New payout" must stay one press away, and a link cannot sit inside a button, so it is a round action at the
  end of the capsule (a pill with its words from 40rem up): filled with the capsule's ink on the payouts page, where starting one is
  the point, a quiet outline elsewhere, and not drawn while paying. The two `role="status"` lines (practice chain, chain mode
  unknown) are on a quiet line of their own directly under the capsule, in the page's flow.
- **Where it sits.** `position: sticky` below the practice banner (which scrolls away; the capsule stays), half a rem under the
  screen's bezel (14px on a phone, 16px from 40rem up; or the safe-area inset, should a page ever draw under a notch), so that it sits like
  a notch in the curved screen, opaque while the page scrolls under it, above the page's own raised parts and below dialogs, the popover and the
  toaster, and not printed. Its strip is as tall as the closed capsule and lets presses through around it. `html` has a
  `scroll-padding-top` so that a heading the skip link scrolls to, or a control that is tabbed to, does not end up under it, and the
  tour's sticky column sticks below it.
- **Motion.** The only motion is the morph, and only while the visitor is opening or closing it: a width from the capsule's own to the
  panel's (measured in pixels, because a width of `fit-content` cannot be animated), the panel's row growing from nothing, the
  radius from 22px to 28px, the contents fading in a row after the other and out at once. The transitions are on only for a moment
  after a press (`data-morph`), so nothing moves on load or on scroll, and a page name that changes the capsule's width does not
  tween it. Under the system's "reduce motion" nothing animates at all (the global rule), and Calm shortens it.
- **Forced colours** (Windows high contrast): a one-pixel outline makes it a bordered box, the mark keeps the text colour, the
  current link is underlined, and the network is in words, so nothing a colour said is lost.
- **Why not the old header.** A full-width row had to hold a name, five links, the network, two icons and, on the operator's side, a
  button and two status pills: a Menu button below 1024px and three lines on a phone. The capsule holds the three things that are
  always wanted (where you are, what network, the way in) and puts the rest one press away, at every width. What went: the
  header's border, the Menu popover, and the logo link (the capsule is a button; Home is a link in the panel).

## The screen

The owner asked for a notch that can be *felt* (2026-10-19), so the page is paper and ink seen on a device: the screen has rounded
corners, the capsule is the notch, the black redaction bar is the bezel. Three rules, and what each one made:

1. **Concentric curves.** One scale from the screen's corner to the smallest chip, and where a box sits in another with a little padding its
   radius is the outer one less that padding (the capsule's rows are `--r-island-open` minus the panel's half rem). Tokens, in
   `src/index.css`: `--screen-r` 26px (30px from 40rem), `--r-island` 22px (half the closed capsule; 28px open), `--r-card` 20px,
   `--r-control` 14px, `--r-chip` a pill. Nothing else names a radius for a card or a field.
2. **Tactile response.** Everything that can be pressed answers within 100ms and nothing moves on its own (below).
3. **Quiet material.** Cards are slips of paper, not grey boxes; there is a very faint grain; nothing is glossy, blurred or gradient.

- **The frame.** A fixed element, `pointer-events: none`, drawn as a ring of the bezel colour around a window with rounded corners
  (`inset: var(--bezel-w); border-radius: var(--screen-r); box-shadow: 0 0 0 100vmax var(--bezel)`), 6px wide on a phone and 8px from 40rem up.
  The window keeps scrolling (it is not a scroll container), so the browser's own chrome, scroll restoration and anchors behave as before.
  The bezel is `--p-bezel`: ink (`#0b0b0b`) in the light set, pure black in the dark one, where a hairline of the ink (`--bezel-edge`) on the
  curve keeps the shape from vanishing. It is above the page and the practice banner (`z-index` 30), below the capsule (40), the popovers
  (50) and the toast (60), and the browser's top layer draws the dialogs above it. It is not printed and not drawn in forced colours.
- **Nothing is clipped by the curves.** A box's corner is inside the screen only if it is at least `--frame-pad` (the bezel plus 0.3 of the
  radius) from both edges, so the skip link, the practice banner and the page's own padding keep to it, and `e2e/screen.spec.ts` checks it with
  real boxes: at 360, 390, 768 and 1280px, on every public page, the top corners at the top and the bottom corners at the end of the page,
  every focusable element and every line of text (a rounded box by the middle of its arc) is inside the rounded screen. The confirm sheet on
  a phone sits a bezel's width in from the edges and its bottom corners take the screen's radius.
- **Slips.** `.slip`: the card colour, `--r-card`, a hairline edge and two shadows of the ink, one tight and one long
  (`0 1px 0 ink/6%, 0 14px 24px -18px ink/35%`), and in the dark set a lighter edge in place of a shadow, which would not show. In forced colours
  they get an outline.
- **Grain.** `public/grain.png`, a 128px tile of black speckle in four opacities, 4KB, made by `scripts/make-grain.mjs` from a seeded generator (so
  it is the same file every time), drawn at 3.5% as one fixed layer behind the content (`body::before`, `z-index: -1`), turned white at 3% in
  the dark set. A file of the site's own because the hosted policy (`default-src 'self'`) allows no `data:` image. It costs no layout, does not move
  with a scroll, takes no press, and the slips sit above it so that they stay clean.
- **Press.** `.press` on buttons, `.press-only` on what has no lift of its own (rows in the capsule's menu, the labels of a segmented
  control, the rows of the payouts list and the lens's rows where a row can be chosen): pressed, it gives (a pixel down, scaled to .98) in
  90ms and springs back in about 200ms; under a pointer that hovers, and when Lively, a `.press` thing lifts a pixel with a soft shadow of the
  ink. The lift has a two-pixel halo (a transparent part of the same element) so that the pointer on its lowest pixel does not lose it as it
  lifts, and its shadow is never drawn on a thing the keyboard has focused, because the focus ring is a shadow too. Calm shortens all of it,
  and under "reduce motion" it is gone: a pressed thing is its colour alone.
- **Segmented controls.** One pill that glides to the chosen option in 220ms with a small spring (`--motion` scales it). It is the ink
  (the marker in the dark set), the action's colour, as the buttons are.
- **Redaction bars answer touch.** A hidden bar in the lens (the home page's *Same payout, three views*, the receipt's *What the public sees*,
  the operator's check) shows its label, *hidden*, sliding up inside it under a pointer or a finger, and puts it away again. Always the same
  word, never a figure. It is drawn by the stylesheet with an empty alternative text (`content: "hidden" / ""`), so no screen reader reads
  it, and the bar's own name is still the one thing read; a browser that does not know that syntax draws none.
- **A new page.** Where the browser has the View Transitions API, a new page cross-fades in 180ms and the capsule, which has a
  `view-transition-name` of its own, stays put (only its width changes, with the name of the page). The declarative router's links cannot ask
  for one (`viewTransition` is a data router's option), so `src/lib/view-transition.ts` makes the history's `push` the transition, and holds the
  browser until the router has put the new page on the screen (`ViewTransitionGate`). Back and forward, and a redirect, change the page as
  they always did; so does a browser without the API, and nothing is asked of the API under "reduce motion".
- **A page opened by a link starts at its top.** The declarative router does not reset the scroll, so a link at the foot of a page used to open
  the next page at the same depth, with its heading far above the window (and, on the practice payout, under the capsule). `ScrollToTop` goes to
  the top when the path changes by a push or a replace; going back or forward, and a change of the address that leaves the path alone (a choice
  in the query, a hash), move nothing. It runs in the commit that shows the new page, so the cross-fade's picture of it is taken at the top.
- **Narrow screens.** Nothing is wider than the screen from 320px up (the width WCAG 2.2, 1.4.10 Reflow, names; it is also what a desktop window
  is at 400% zoom). `e2e/responsive.spec.ts` asks it of every public page at 320, 340, 360, 375, 414, 600, 768 and 1024px, and of every screen of
  the practice payout, the operator's screens, at 320x568, in landscape at 667x375, and at 768x1024: no sideways scroll, no box wider than the
  screen unless it sits inside one that scrolls or hides its own overflow, the capsule whole and inside the screen, the confirm sheet inside its
  window or scrolling, and its buttons within reach. The operator's own pages, against the real operator, are walked at 320px as well as at 360
  and 1280px by `e2e/operator/a11y.spec.ts` (every page and state it names, in both themes: overflow, console and axe). What it found: the home
  page scrolled sideways below 357px, because the practice button's long label could not wrap; it wraps now and the button grows to fit it
  (`PracticeStart.tsx`). What it does not cover: below 320px (at 300px
  the home page is 7px too wide; at 280px, 27px, and the privacy table 9px), a browser whose default text size is not 16px (the root is fixed at
  16px, so the page does not follow it; zoom does), and any engine but Chromium.

### Chosen by eye (say "more" or "less" to each)

Each of these is one number in `src/index.css` (`--bezel-w`, `--screen-r`, `--r-card`, `--r-control`, `--grain-opacity`, the `.slip` shadows, the
`.press` timings). To take the frame away altogether, set `--bezel-w` and `--screen-r` to 0 and, for the dark set's hairline, `--bezel-edge` to
`transparent`: the ring then lies outside the window and draws nothing. What is measured from it follows: the capsule sits half a rem from the
top, and the skip link and the confirm sheet go to the window's edge.

| What | Chosen | Why |
|---|---|---|
| Bezel width | 6px phone, 8px from 40rem | Thick enough to read as a frame on a white page, thin enough to give up almost no screen |
| Screen radius | 26px phone, 30px from 40rem | The curve of a recent phone; 30px reads on a laptop window too |
| Capsule offset | half a rem under the bezel | Close enough to the edge to read as a notch, far enough to leave the curve alone |
| Buttons, chips, segmented controls | pills | They speak the capsule's language; a 14px button looked like a different family |
| Cards | 20px slips | Concentric with the capsule's open panel (28px) at the padding the panel has |
| Fields | 14px, not pills | A pill is wrong for a box that holds several lines of text |
| Slip shadow | ink at 6% tight, 35% long | Reads as paper a little above the desk and not as a grey card |
| Grain | 3.5% light, 3% dark | Visible if you look for it on a large screen, invisible in use |
| Press | scale .98, 1px down, 90ms in, 200ms spring back | Answers inside 100ms and does not read as a bounce |

### The tour's pictures

The tour's pictures (`public/tour/`) are captures of the operator's screens and had been taken before the capsule (they showed the old
full-width header). They were taken again for this change with `e2e/operator/tour-shots.spec.ts`, which now leaves the frame and the grain out
of them (`--grain-opacity: 0`, and the frame not drawn): they are pictures of the operator's screens, and a frame inside the page's own frame
would be no help. The same sizes, so the page holds the same space.

### Not done here (stage 2)

The capsule's live activity (the progress of a running payout, on every page): the capsule is one button with a name made of its parts, so a
fourth part ("Sending, 1 of 3") has room, and its width is measured, so it grows. Richer practice-mode guidance is untouched. (The hero
moment on the home page was done on 2026-10-20: "Home", above.)
