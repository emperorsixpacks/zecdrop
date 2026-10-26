# auditor-disclosure

### REQ-AUD-001 — Local audit reconciles to the public total
Status: implemented
Audit SHALL run locally, recover every output with the campaign UFVK, and for each batch SHALL report whether the
number of recovered outputs equals the public action count (for batches of two or more) and whether the sum of
recovered amounts equals the public net value into the pool; any difference SHALL be reported, not rounded away,
because it indicates a hidden spend, a hidden output or an output built without the campaign OVK.

### REQ-AUD-002 — Per-campaign account isolation
Status: implemented
Each campaign SHALL use its own ZIP-32 account, and the UFVK of one campaign SHALL NOT recover outputs of another.

### REQ-AUD-003 — Manifest commitment check
Status: implemented
Audit SHALL recompute the salted manifest commitment from the recovered outputs and the supplied manifest and
SHALL report whether it equals the commitment on the public receipt.
