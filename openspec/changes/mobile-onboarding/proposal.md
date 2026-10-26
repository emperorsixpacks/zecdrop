# mobile-onboarding

## Why
The Shielded Payments track asks for private payments that feel effortless and belong in everyday life. ZecDrop's recipients
already live on phones (any shielded wallet), but three things make the product hard to pick up there: a recipient has no plain
place to learn how to be paid, an organizer who funds a campaign from a phone wallet has to copy an address by hand from a
computer, and nobody can try the organizer's flow without building and running the operator. This change closes those three
gaps without moving any key off the organizer's machine.

## What
- **A "get paid" page** (`/get-paid`), mobile first: how to get a shielded wallet, how to copy the right address, a local check of
  the address's shape, and a one-tap way to share it with whoever pays. Static: no request, no storage.
- **A QR code for the funding request** next to the funding address (the same ZIP-321 request the "Open in wallet" link carries), so
  a phone wallet can scan it, and **payslips as a link or a QR code** so a recipient can show proof of a payout from a phone. The
  payslip is carried only after the `#` of the link, which a browser never sends to a server.
- **Practice mode** ("Try it in your browser"): the operator's real screens run against a simulation inside the page, so anyone,
  on a phone, can go through a whole payout with no install and no money. It is labelled as a simulation on every screen.

## Approach
Web-only. Payment URIs already exist (`web/src/lib/payment-uri.ts`); the QR is drawn from the same string by a small vetted
library, as SVG. The payslip link reuses the payslip's strict reader and the page that checks it; the fragment is read once and
removed from the address bar. Practice mode is a second implementation of the operator's HTTP contract that runs in memory in the
page and is installed only when the visitor turns it on; the screens themselves are unchanged, and their strict response parsers
(the same ones that parse the real operator's answers) check the simulation against the contract.

## Scope decisions
- **No native app and no hosted operator.** An operator holds keys and proves transactions on the organizer's computer
  (ADR 0002). Practice mode is a simulation, not a hosted operator: it holds no key and talks to no chain.
- **The address check is of shape only.** The page does not verify a unified address's checksum, so it says so; the operator
  (and its codec) is the real check.
- **A payslip link is a bearer document in a URL.** Anyone who gets the link can read the receiver, the amount and the key to the
  memo, and can present it. The page says so where the link is made, and the check itself still asks for a tap.
- **Not built:** a first-run wizard and downloadable builds for the organizer, a progressive web app, scanning a recipient's QR to
  fill the payout list.

## Risks
- A simulation can be mistaken for the real thing. It says what it is on every screen, shows no figure as chain data, and its tests
  assert that nothing leaves the page.
- A QR code that does not scan is worse than none: a test decodes the rendered code and compares it with the link.
- A payslip in a URL may be kept by browser history and by whatever app it is shared through: the page removes the fragment from
  the address bar and says what a link is.
