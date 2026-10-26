# Tasks — spike-single-tx-builder

- [ ] Pick a compatible crate set on rustc 1.92; record versions and MSRV
- [ ] Build transparent → N Ironwood outputs (V6) with OVK (REQ-TX-001, REQ-TX-002)
- [ ] Demonstrate the Orchard-output variant violates ZIP-258 (value balance sign)
- [ ] Confirm existing recipient UAs receive Ironwood outputs; list SDKs that can scan them
- [ ] Re-parse and recompute `t_in = t_out + net_into_pool + fee` from public data
- [ ] Decrypt with recipient IVK and campaign UFVK; negative test with `OVK = None`
- [ ] Memo encoding check (REQ-TX-003)
- [ ] Measure size / proving time / fee for N ∈ {2, 5, 10, 25, 50, 100, 200}
- [ ] Verify the relay-policy size limit against Zebra's real policy
- [ ] Answer: can `zcash_client_backend` do transparent → external shielded in one tx?
- [ ] Read what "Ironwood" is and whether it changes the pool choice (ADR 0005)
- [ ] Update ADR 0001 to Accepted or Rejected; record numbers in `docs/LEARNINGS.md`
