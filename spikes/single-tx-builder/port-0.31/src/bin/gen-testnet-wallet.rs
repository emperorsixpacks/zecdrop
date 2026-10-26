//! Creates (once) or reuses the TESTNET dev seed at `~/.zecdrop-dev/testnet.seed` and prints the
//! campaign account's faucet-fundable addresses. The seed itself is never printed.

use single_tx_builder_port031::{devseed, Campaign, Recipient};
use zcash_keys::address::Address;
use zcash_protocol::consensus::TEST_NETWORK;
use zip32::AccountId;

fn main() {
    let (seed, origin) = devseed::load_or_create().unwrap_or_else(|e| {
        eprintln!("dev seed: {e}");
        std::process::exit(1);
    });
    let path = devseed::path().expect("HOME is set");
    println!(
        "TESTNET dev seed: {} ({origin:?}; contents never printed)",
        path.display()
    );

    let campaign = Campaign::from_seed(seed.as_bytes(), AccountId::ZERO);
    println!("\nCampaign = ZIP 32 account 0 (testnet)");
    println!(
        "  FUND THIS transparent address : {}",
        Address::from(campaign.funding_addr).encode(&TEST_NETWORK)
    );
    println!(
        "  change address (internal)     : {}",
        Address::from(campaign.change_addr).encode(&TEST_NETWORK)
    );
    println!(
        "  Unified Address (Orchard rcv) : {}",
        campaign.unified_address()
    );
    println!(
        "  campaign UFVK (auditor key)   : {}",
        campaign.ufvk_encoded()
    );

    println!("\nDev recipients (accounts 1-3 of the same seed):");
    for i in 1..=3u32 {
        let r = Recipient::from_seed(
            seed.as_bytes(),
            AccountId::try_from(i).expect("valid account"),
        );
        println!("  account {i}: {}", r.unified_address);
    }
    println!(
        "\nThe batch spends TRANSPARENT coins: send faucet funds to the t-address above, not the UA \
         (a UA payment would land in the Ironwood pool, which the batch does not spend)."
    );
}
