# everyday-payouts

## Why
The owner wants ZecDrop to belong in everyday life, not only in an organisation's payroll: someone sending money home to their
family every month, paying holiday gifts to cousins, splitting a tip jar among staff or prize money among a team. Two things stop
that today. A payer has to bring a CSV file, which most people have never made, and the only way to give anyone a payslip is a
terminal command (`drop-operator payslips`), so recipients rarely get one. This change removes both without moving any key off the
payer's machine.

## What
- **A payout list built in the page**, one person at a time: an address, an amount and the note they will see. A total can be
  split evenly or as a "lucky split" of random shares. The page turns the list into the same CSV text the operator already
  imports, so the operator's importer stays the one gate and nothing on the chain side changes. Importing a CSV file stays, as a
  secondary choice, for big payrolls.
- **Payslips from the payer's screen.** Once a payout has settled, the operator's page lists every person with their payslip, and
  each can be sent as a link or a QR code with the screens that already exist for one payslip. The operator issues them from the
  transaction bytes it stored before broadcast, so the page needs no chain access of its own.

## Approach
The list is a component in front of the existing create call: it produces `address,amount,memo` text (RFC 4180 quoting, amounts
written by the same formatter the importer is the inverse of), and every check the operator makes still runs there. Splits are
computed in zatoshi with whole-number arithmetic; random shares come from the browser's cryptographic random numbers.

Payslips use a new protected route, `GET /api/campaigns/{id}/payslips`. It is the second deliberate exception to "no response
carries an address, an amount or a memo", after the viewing-key export, and it gets the same treatment: an explicit disclosure
header, a fixed warning in the answer, nothing logged but the route, `no-store`, and a page that keeps the answer in memory only
and hides it again. The issuing code is the CLI's, split so that the matching of payout rows to opened outputs runs on stored bytes
as well as on bytes fetched from a node.

## Scope decisions
- **No name per person.** The importer accepts only `address`, `amount` and `memo`, and an extra column is an error on purpose (an
  extra column could carry data). A person is "Person N" and their note, as on the Check stage.
- **Even shares stay exactly equal.** Spreading a remainder of a few zatoshi would silence the uniform-amount warning while every
  share stays guessable from the public total, so an even split leaves the remainder out of the total and says so; the warning
  then fires as it should.
- **The address check in the list is a hint.** The page checks the shape only; the operator's codec is the check that counts, and
  its answer is shown on the row it is about.
- **No payslips on the mock chain or in practice mode.** Their transactions are not real, so nothing could prove an output. The
  route answers 409 `not_available` there, as the viewing-key export does, and the page says why.
- **Personal and organisation views** (scope addition, owner, 2026-10-20: "making the UI easier to navigate and less
  crowded"). The landing page shows two doors, Personal and Organisation, each opening a practice payout in its own view, and
  the payouts step opens with a switch between them, kept on the browser like the theme. Personal shows the people list and
  leaves out the file import, the fee and batch options, the batch list, the list fingerprint and the auditor's tools;
  Organisation starts from the file and keeps everything. It changes what is shown, never what is sent, built or proved, so it
  needs no requirement of its own; anything hidden is one switch away.
- **Not built:** a name column; pasting many addresses at once or scanning a QR code to add someone; paying the same people again;
  saved groups and schedules; an income statement combining payslips; gift links for people without a wallet; the audit on screen;
  a packaged desktop app (starting the operator and typing its passphrase stay in a terminal: the store is unlocked before the
  server listens, REQ-SEC-002).

## Risks
- A list built by hand is easier to get wrong than a file checked twice. Every row shows its own problem, the total counts as it is
  typed, and the Check stage and the confirm sheet still stand between the list and the send.
- A page that holds every payslip of a payout holds every receiver and amount of it. It asks before it fetches them, keeps them in
  memory only, hides them after ten minutes or when the page is left, and makes a link only when asked; the warning that a payslip
  is a bearer document is read before any button.
- A link made on the operator's own page points at `127.0.0.1` unless the page was built with a public base address: the page says
  so (the existing loopback note), and the runbooks build it with the public site's address.
