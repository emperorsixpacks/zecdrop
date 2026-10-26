# everyday-payouts

### REQ-IMP-002 — A payout list can be built in the page without a file
Status: implemented
The payouts step SHALL let a payer build the payout list one person at a time (an address, an amount, an optional note) and SHALL
turn it into `address,amount,memo` text that the CSV importer (REQ-IMP-001) accepts unchanged, with every field quoted as RFC 4180
requires and every amount written as the importer's own decimal form. It SHALL be able to split a total evenly, every share exactly
equal and the remainder left out of the total, or at random, from the browser's cryptographic random numbers, the shares adding up
to the total exactly, none smaller than half of an even share and never all equal. It SHALL show each row's problem on that row,
including a problem the operator reports for the row's line, and SHALL keep importing a file as a choice. A negative test SHALL show
that the list appears in no storage, no address bar, no console line and no request other than the create call.

### REQ-PAY-005 — The payer's screen gives each person their payslip
Status: planned
Once every batch of a campaign is confirmed at the required depth, the operator SHALL issue the campaign's payslips to its own page
from the transaction bytes it stored before broadcast, one per payout row in payout-list order, each checked against its output
before it is returned, through a protected route that SHALL refuse without an explicit disclosure header, SHALL refuse on the mock
chain and for a campaign that is not settled, and SHALL log nothing but the route. The page SHALL ask before it fetches them, SHALL
keep them in memory only and hide them again after ten minutes or when the page is left, and SHALL make a person's link or QR code
only when asked, with the warning that a payslip is a bearer document shown first. A negative test SHALL show that no address,
amount or memo appears in the operator's logs, its error answers or its store file, and that no payslip appears in the page's
storage, its console or any request other than the export.
