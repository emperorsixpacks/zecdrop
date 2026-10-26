# run-it-yourself

## Why
On 2026-10-25 the owner said ZecDrop felt like a demo, not a product: nowhere could a person make a real payout. The public
site holds no keys, so it cannot pay anyone, and its main buttons started practice mode, a simulation. The operator, which holds
the keys and made every real testnet payout, could only be started by building Rust from source and passing server flags, and
the site named no command or link for it. The owner also found the site's text overwhelming and asked for it to be as short as
Ferry's.

Decided with the owner: a real payout happens on the payer's own computer, started with one command, so the keys and the list
never leave it (ADR 0002 stands: no shared or hosted operator). Practice mode goes.

## What
- **One command** (REQ-RUN-001): `./zecdrop up` builds and starts the operator in Docker on testnet, with the wallet and the
  payout lists in a folder of the person's own, and opens its page, published on the computer's loopback address only.
- **The site gives that command** (REQ-RUN-002) on a short page of its own, and its home page says what ZecDrop does in a few
  short lines. No simulated payout anywhere.
- **A real payout anyone can finish** (REQ-RUN-003): on testnet the funding screen points to the testnet faucet, and the payout
  screen offers the example list of the project's own test addresses.
- **Amends REQ-OPS-002**: inside a container (`--container`, testnet only) the operator may listen on the container's own
  network, for a port published on the host's loopback address only. Its Host check and per-run token are unchanged.
- **Retires REQ-DEMO-001** (practice mode), removed from `mobile-onboarding`'s spec with every test that covered it.
