# batch-transaction

### REQ-TX-001 — Batch transaction shape
Status: implemented
A batch transaction SHALL contain transparent inputs and Ironwood outputs only (plus optional transparent change)
and SHALL NOT contain real shielded spends, nor any value entering the Orchard pool (ZIP-258), so that
`t_in = t_out + net_into_pool + fee` holds and is checkable from public data.

### REQ-TX-002 — Outputs recoverable by the campaign viewing key
Status: implemented
Every shielded output SHALL be created with the campaign account's outgoing viewing key so that a holder of that
account's UFVK can recover it. A transaction built without an OVK SHALL be treated as a defect.

### REQ-TX-003 — Memo encoding
Status: implemented
Memos SHALL follow ZIP-302: UTF-8 text padded with zero bytes, at most 512 bytes; an over-length memo SHALL be
rejected before building.
