# run-it-yourself

### REQ-RUN-001 — One command runs the operator on your own computer
Status: planned
`./zecdrop up` SHALL build the operator's image the first time, keep the wallet and the payout lists in a folder of the person's
own that only they can read, make the wallet once, start the operator on testnet, and open its page; `down`, `status`, `logs`,
`open` and `update` SHALL do what they say. It SHALL publish the page on the computer's loopback address only, SHALL never run on
mainnet, and SHALL pass the store's passphrase to Docker in a file only the person can read, never on a command line. The operator
SHALL listen on a container's own network only when told it runs in one (`--container`), which it SHALL refuse outside testnet;
its link SHALL then name the computer's loopback address, and its Host check and per-run token SHALL be unchanged.

### REQ-RUN-002 — The site says how to make a real payout, and simulates nothing
Status: planned
The public site SHALL give the command that runs ZecDrop on one's own computer on a page of its own, linked from its first
screen, its menu, its footer, and every operator page it cannot serve, and SHALL say there what is needed and what happens next.
Its home page SHALL say what ZecDrop does in under 400 words. The site SHALL run no simulated payout and SHALL say "practice"
nowhere.

### REQ-RUN-003 — Anyone can finish a real testnet payout
Status: planned
On testnet, the operator's funding screen SHALL point to a testnet faucet that pays the payout's funding address directly, and its
payout screen SHALL offer the example list of the project's own test addresses, saying whose they are. On mainnet neither SHALL
appear.
