//! Issuing payslips (local only): one recipient's proof of payment, built from a key that opens
//! the output. The key-less check is `drop_verify::payslip`.
//!
//! * [`issue_payslips`]: the campaign operator, from the campaign UFVK. One payslip for every
//!   Ironwood output the UFVK's outgoing viewing keys recover, whichever recipient it went to.
//! * [`payslips_with_ivk`]: a recipient, from their own incoming viewing key. The same payslips
//!   for the outputs addressed to that key, with no help from the operator.
//!
//! Both run where the key is and print nothing. Hand each payslip only to its recipient: it
//! names the recipient's receiver and amount, and its `rseed` also opens that output's memo.
//!
//! The action index in a payslip comes straight from recovery, which reports the position of
//! each recovered output in the Ironwood bundle (wire order). Builders shuffle actions, so it is
//! unrelated to the payout list's order: match a payslip to a payout row by receiver, not by
//! position. Padding actions (a bundle holds at least two) are never recovered, so they get no
//! payslip.

use drop_verify::payslip::{verify_payslip_in, Payslip};
use drop_verify::ParsedTx;
use orchard::{keys::IncomingViewingKey, Note};
use thiserror::Error;
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_protocol::consensus::Network;

use crate::inspect::{self, InspectError};

/// Why payslips could not be issued. Fixed text; never a key, address or amount.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum IssueError {
    /// The transaction or the viewing key could not be read.
    #[error(transparent)]
    Inspect(#[from] InspectError),
    /// A recovered output did not yield a payslip that verifies against its own transaction.
    /// Nothing is returned in that case.
    #[error("a recovered output does not verify as a payslip against its own transaction")]
    Unverifiable,
}

fn core_network(network: Network) -> drop_core::Network {
    match network {
        Network::MainNetwork => drop_core::Network::Mainnet,
        Network::TestNetwork => drop_core::Network::Testnet,
    }
}

/// A payslip for every Ironwood output of `raw` that the campaign UFVK's outgoing viewing keys
/// recover (outputs in any other pool are ignored). Empty if the key recovers nothing: another
/// campaign's key, or no Ironwood bundle.
pub fn issue_payslips(
    raw: &[u8],
    network: Network,
    ufvk: &str,
) -> Result<Vec<Payslip>, IssueError> {
    let ufvk =
        UnifiedFullViewingKey::decode(&network, ufvk).map_err(|_| InspectError::BadViewingKey)?;
    let ovks = inspect::candidate_ovks(&ufvk);
    let tx = inspect::parse(raw)?;
    let found = tx.ironwood_bundle().map_or_else(Vec::new, |bundle| {
        bundle
            .recover_outputs_with_ovks(&ovks)
            .into_iter()
            .map(|(index, _, note, _, _memo)| (index, note))
            .collect()
    });
    payslips(raw, network, found)
}

/// A payslip for every Ironwood output of `raw` addressed to `ivk`. This is what a recipient
/// can issue for themselves.
pub fn payslips_with_ivk(
    raw: &[u8],
    network: Network,
    ivk: &IncomingViewingKey,
) -> Result<Vec<Payslip>, IssueError> {
    let tx = inspect::parse(raw)?;
    let found = tx.ironwood_bundle().map_or_else(Vec::new, |bundle| {
        bundle
            .decrypt_outputs_with_keys(std::slice::from_ref(ivk))
            .into_iter()
            .map(|(index, _, note, _, _memo)| (index, note))
            .collect()
    });
    payslips(raw, network, found)
}

/// Turns recovered notes into payslips, each checked with the verifier's own code against the
/// transaction it came from before it is handed out.
fn payslips(
    raw: &[u8],
    network: Network,
    found: Vec<(usize, Note)>,
) -> Result<Vec<Payslip>, IssueError> {
    if found.is_empty() {
        return Ok(Vec::new());
    }
    let parsed = ParsedTx::parse(raw).map_err(|_| IssueError::Unverifiable)?;
    found
        .into_iter()
        .map(|(index, note)| {
            let slip = u32::try_from(index)
                .ok()
                .and_then(|action| {
                    Payslip::from_note(core_network(network), parsed.txid(), action, &note)
                })
                .ok_or(IssueError::Unverifiable)?;
            verify_payslip_in(&parsed, &slip).map_err(|_| IssueError::Unverifiable)?;
            Ok(slip)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::OnceLock;

    use drop_core::fee::FeePolicy;
    use drop_verify::payslip::{verify_payslip, PayslipError, PayslipProof, PAYSLIP_VERSION};
    use rand_chacha::ChaCha20Rng;
    use rand_core::SeedableRng;
    use zcash_protocol::consensus::Network::TestNetwork;

    use super::*;
    use crate::builder::tests::{fake_coin, nu7_height, payouts, shared_batch};
    use crate::builder::{build_batch_tx, fee_rule, BuiltTx};
    use crate::keys::tests::test_keys;
    use crate::txid::to_core;

    fn ufvk() -> String {
        test_keys(0).ufvk_encoded().unwrap()
    }

    /// The payslips of the shared 3-payout batch.
    fn shared_slips() -> &'static Vec<Payslip> {
        static SLIPS: OnceLock<Vec<Payslip>> = OnceLock::new();
        SLIPS.get_or_init(|| issue_payslips(&shared_batch().0.raw, TestNetwork, &ufvk()).unwrap())
    }

    fn build(payouts: &[crate::builder::PayoutLine], seed: u64) -> BuiltTx {
        let keys = test_keys(0);
        build_batch_tx(
            &keys,
            nu7_height(),
            orchard::Anchor::empty_tree(),
            std::slice::from_ref(&fake_coin(&keys, 1_000_000)),
            payouts,
            &fee_rule(&FeePolicy::zip317_text()).unwrap(),
            &mut ChaCha20Rng::seed_from_u64(seed),
        )
        .unwrap()
    }

    /// The same three payouts as the shared batch, paid in a different transaction.
    fn other_batch() -> &'static BuiltTx {
        static BATCH: OnceLock<BuiltTx> = OnceLock::new();
        BATCH.get_or_init(|| build(&payouts(3), 8))
    }

    /// One payout: the bundle is padded to two actions.
    fn single_batch() -> &'static BuiltTx {
        static BATCH: OnceLock<BuiltTx> = OnceLock::new();
        BATCH.get_or_init(|| build(&payouts(1), 9))
    }

    fn receiver(i: usize) -> [u8; 43] {
        payouts(3)[i].receiver.to_raw_address_bytes()
    }

    /// The payslip for payout `i` of the shared batch (found by receiver, never by position).
    fn slip(i: usize) -> Payslip {
        let receiver = receiver(i);
        let mut mine = shared_slips().iter().filter(|s| s.receiver == receiver);
        let found = mine.next().unwrap().clone();
        assert!(mine.next().is_none(), "one payslip per recipient");
        found
    }

    fn raw() -> &'static [u8] {
        &shared_batch().0.raw
    }

    // covers: REQ-PAY-002
    #[test]
    fn every_payout_gets_a_payslip_that_verifies() {
        let slips = shared_slips();
        assert_eq!(slips.len(), 3);
        let txid = to_core(&shared_batch().0.txid);
        for (i, payout) in payouts(3).iter().enumerate() {
            let mine = slip(i);
            assert_eq!(mine.value.as_u64(), u64::from(payout.value));
            assert_eq!(
                (mine.version, mine.network, mine.txid),
                (PAYSLIP_VERSION, drop_core::Network::Testnet, txid)
            );
            let proof = verify_payslip(raw(), &mine).unwrap();
            assert_eq!(
                proof,
                PayslipProof {
                    txid,
                    action: mine.action,
                    ironwood_actions: 3
                }
            );
        }
        // Three outputs in a three-action bundle: every action is one of them, once. Their order
        // is the builder's shuffle, not the payout list's.
        let actions: BTreeSet<u32> = slips.iter().map(|s| s.action).collect();
        assert_eq!(actions, BTreeSet::from([0, 1, 2]));
    }

    // covers: REQ-PAY-002
    #[test]
    fn payslips_survive_json_and_stay_small() {
        for i in 0..3 {
            let mine = slip(i);
            let json = serde_json::to_string(&mine).unwrap();
            assert!(json.len() < 400, "{} bytes", json.len());
            let back: Payslip = serde_json::from_str(&json).unwrap();
            assert_eq!(back, mine);
            verify_payslip(raw(), &back).unwrap();
        }
    }

    // covers: REQ-PAY-002
    #[test]
    fn issued_payslips_are_exactly_what_the_auditor_recovers() {
        let recovered =
            inspect::recover_with_ufvk(raw(), TestNetwork, &ufvk()).expect("the key decodes");
        let from_audit: BTreeSet<(u32, [u8; 43], u64)> = recovered
            .iter()
            .map(|o| {
                (
                    u32::try_from(o.action_index).unwrap(),
                    o.recipient.to_raw_address_bytes(),
                    o.value,
                )
            })
            .collect();
        let from_slips: BTreeSet<(u32, [u8; 43], u64)> = shared_slips()
            .iter()
            .map(|s| (s.action, s.receiver, s.value.as_u64()))
            .collect();
        assert_eq!(from_audit, from_slips);
    }

    // covers: REQ-PAY-002
    #[test]
    fn a_recipient_issues_their_own_payslip_with_only_their_viewing_key() {
        // Payout 1 went to account 11 of the TEST ONLY seed.
        let ivk = test_keys(11)
            .ufvk()
            .orchard()
            .unwrap()
            .to_ivk(orchard::keys::Scope::External);
        let own = payslips_with_ivk(raw(), TestNetwork, &ivk).unwrap();
        assert_eq!(own, vec![slip(1)], "the same payslip the operator issues");
        verify_payslip(raw(), &own[0]).unwrap();
    }

    // covers: REQ-PAY-002
    #[test]
    fn another_campaigns_key_issues_nothing_and_a_bad_key_is_refused() {
        let other = test_keys(1).ufvk_encoded().unwrap();
        assert!(issue_payslips(raw(), TestNetwork, &other)
            .unwrap()
            .is_empty());
        assert_eq!(
            issue_payslips(raw(), TestNetwork, "not a key").unwrap_err(),
            IssueError::Inspect(InspectError::BadViewingKey)
        );
        // A mainnet-network decode of a testnet key fails too.
        assert!(issue_payslips(raw(), Network::MainNetwork, &ufvk()).is_err());
    }

    // covers: REQ-PAY-002
    #[test]
    fn a_single_recipient_batch_is_padded_and_only_the_real_output_has_a_payslip() {
        let tx = single_batch();
        let slips = issue_payslips(&tx.raw, TestNetwork, &ufvk()).unwrap();
        assert_eq!(slips.len(), 1, "the padding action is not recoverable");
        let proof = verify_payslip(&tx.raw, &slips[0]).unwrap();
        assert_eq!(
            proof.ironwood_actions, 2,
            "one output is padded to two actions"
        );
        assert_eq!(slips[0].receiver, receiver(0));
        // The padding action is a zero-value note to a throwaway address: no payslip opens it.
        let mut onto_padding = slips[0].clone();
        onto_padding.action = 1 - slips[0].action;
        assert_eq!(
            verify_payslip(&tx.raw, &onto_padding).unwrap_err(),
            PayslipError::CommitmentMismatch
        );
    }

    // ---- what must fail ---------------------------------------------------------------------

    fn rejects(raw: &[u8], payslip: &Payslip) -> PayslipError {
        verify_payslip(raw, payslip).expect_err("a payslip that must not verify")
    }

    // covers: REQ-PAY-001
    #[test]
    fn a_tampered_value_fails() {
        let good = slip(0);
        for value in [
            good.value.as_u64() + 1,
            good.value.as_u64() - 1,
            0,
            slip(1).value.as_u64(), // another recipient's amount
        ] {
            let mut bad = good.clone();
            bad.value = drop_core::Zatoshi::new(value).unwrap();
            assert_eq!(rejects(raw(), &bad), PayslipError::CommitmentMismatch);
        }
    }

    // covers: REQ-PAY-001
    #[test]
    fn a_tampered_receiver_fails() {
        let good = slip(0);
        // Another recipient's real receiver: a valid address, the wrong note.
        let mut bad = good.clone();
        bad.receiver = receiver(1);
        assert_eq!(rejects(raw(), &bad), PayslipError::CommitmentMismatch);
        // One flipped bit anywhere in the receiver: a different or an invalid address.
        for byte in [0, 10, 11, 25, 42] {
            let mut bad = good.clone();
            bad.receiver[byte] ^= 1;
            assert!(matches!(
                rejects(raw(), &bad),
                PayslipError::CommitmentMismatch | PayslipError::MalformedNote
            ));
        }
    }

    // covers: REQ-PAY-001
    #[test]
    fn a_tampered_rseed_fails() {
        let good = slip(0);
        let mut bad = good.clone();
        bad.rseed[0] ^= 1;
        assert_eq!(rejects(raw(), &bad), PayslipError::CommitmentMismatch);
        bad.rseed = slip(1).rseed; // another recipient's rseed
        assert_eq!(rejects(raw(), &bad), PayslipError::CommitmentMismatch);
        bad.rseed = [0; 32];
        assert_eq!(rejects(raw(), &bad), PayslipError::CommitmentMismatch);
    }

    // covers: REQ-PAY-001
    #[test]
    fn a_wrong_action_index_fails() {
        let good = slip(0);
        for action in (0..3).filter(|a| *a != good.action) {
            let mut bad = good.clone();
            bad.action = action;
            assert_eq!(rejects(raw(), &bad), PayslipError::CommitmentMismatch);
        }
        for action in [3, 4, 1 << 20, u32::MAX] {
            let mut bad = good.clone();
            bad.action = action;
            assert_eq!(rejects(raw(), &bad), PayslipError::ActionOutOfRange);
        }
    }

    // covers: REQ-PAY-001
    #[test]
    fn a_payslip_that_names_another_transaction_fails() {
        // Its txid changed: it names a transaction these bytes are not.
        let mut bad = slip(0);
        bad.txid = drop_core::Txid::from_bytes([0xab; 32]);
        assert_eq!(rejects(raw(), &bad), PayslipError::TxidMismatch);
    }

    // covers: REQ-PAY-001
    #[test]
    fn unreadable_bytes_and_unknown_versions_fail() {
        let good = slip(0);
        let mut future = good.clone();
        future.version = PAYSLIP_VERSION + 1;
        assert_eq!(rejects(raw(), &future), PayslipError::UnsupportedVersion);
        // Not a transaction, and a transaction cut short by a byte.
        assert_eq!(rejects(b"", &good), PayslipError::TxUnparseable);
        assert_eq!(
            rejects(&raw()[..raw().len() - 1], &good),
            PayslipError::TxUnparseable
        );
    }

    // covers: REQ-PAY-001
    #[test]
    fn a_payslip_for_batch_a_does_not_open_batch_b() {
        // Same recipients, same amounts, same funding coin: only the randomness differs.
        let (a, b) = (raw(), &other_batch().raw);
        assert_ne!(a, b.as_slice());
        let b_txid = to_core(&other_batch().txid);
        let b_slips = issue_payslips(b, TestNetwork, &ufvk()).unwrap();
        assert_eq!(b_slips.len(), 3);

        for i in 0..3 {
            let mine = slip(i);
            // Checked against B as it stands: not the transaction it names.
            assert_eq!(rejects(b, &mine), PayslipError::TxidMismatch);
            // Rewritten to name B, at every action of B: B's notes are not A's notes.
            for action in 0..3 {
                let mut forged = mine.clone();
                forged.txid = b_txid;
                forged.action = action;
                assert_eq!(rejects(b, &forged), PayslipError::CommitmentMismatch);
            }
        }
        // And B's own payslips verify against B and not against A.
        for b_slip in &b_slips {
            verify_payslip(b, b_slip).unwrap();
            assert_eq!(rejects(a, b_slip), PayslipError::TxidMismatch);
        }
        // B's payslip for a payout has other rseed than A's for the same payout.
        for i in 0..3 {
            let in_b = b_slips.iter().find(|s| s.receiver == receiver(i)).unwrap();
            assert_eq!(in_b.value, slip(i).value);
            assert_ne!(in_b.rseed, slip(i).rseed);
        }
    }

    // covers: REQ-PAY-001
    #[test]
    fn unknown_json_fields_and_bad_encodings_are_refused() {
        let json = serde_json::to_value(slip(0)).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["action", "network", "receiver", "rseed", "txid", "value", "version"],
            "the payslip format is exactly these fields"
        );
        let with = |field: &str, value: serde_json::Value| {
            let mut copy = json.clone();
            copy[field] = value;
            serde_json::from_value::<Payslip>(copy)
        };
        assert!(with("extra", serde_json::json!("x")).is_err());
        assert!(with("receiver", serde_json::json!("00")).is_err());
        assert!(with("rseed", serde_json::json!("zz".repeat(32))).is_err());
        assert!(with("value", serde_json::json!("21000000000000001")).is_err());
        assert!(
            with("value", serde_json::json!(5)).is_err(),
            "amounts are strings"
        );
        assert!(with("network", serde_json::json!("regtest")).is_err());
    }

    // ---- what must not leak -----------------------------------------------------------------

    /// `text` without runs of 32 or more hexadecimal digits (transaction ids, receivers,
    /// seeds), so decimal amounts can be searched for without matching inside them by chance.
    fn without_hex_runs(text: &str) -> String {
        let mut out = String::new();
        let mut run = String::new();
        for c in text.chars() {
            if c.is_ascii_hexdigit() {
                run.push(c);
            } else {
                if run.len() < 32 {
                    out.push_str(&run);
                }
                run.clear();
                out.push(c);
            }
        }
        if run.len() < 32 {
            out.push_str(&run);
        }
        out
    }

    // covers: REQ-PAY-001
    #[test]
    fn a_payslip_holds_nothing_about_the_other_recipients() {
        for i in 0..3 {
            let json = serde_json::to_string(&slip(i)).unwrap();
            assert!(json.contains(&hex::encode(receiver(i))), "its own receiver");
            for j in (0..3).filter(|j| *j != i) {
                let other = slip(j);
                assert!(!json.contains(&hex::encode(other.receiver)), "receiver {j}");
                assert!(!json.contains(&hex::encode(other.rseed)), "rseed {j}");
                assert!(
                    !json.contains(&format!("\"{}\"", other.value)),
                    "amount {j}"
                );
            }
            // No memo, no key, no payout-list text.
            for secret in ["TEST ONLY", "uview", "ufvk", &ufvk()] {
                assert!(!json.contains(secret), "{secret}");
            }
        }
    }

    // covers: REQ-PRIV-002, REQ-PAY-001
    #[test]
    fn debug_display_and_errors_print_no_receiver_amount_or_seed() {
        // Everything printed for every outcome: success, and each way to fail.
        let mut printed: Vec<String> = Vec::new();
        for i in 0..3 {
            let good = slip(i);
            printed.push(format!("{good:?}"));
            printed.push(format!("{good:#?}"));
            let proof = verify_payslip(raw(), &good).unwrap();
            printed.push(format!("{proof:?}"));

            let mut bad = good.clone();
            bad.value = drop_core::Zatoshi::new(good.value.as_u64() + 1).unwrap();
            let mut other_receiver = good.clone();
            other_receiver.receiver = receiver((i + 1) % 3);
            let mut other_seed = good.clone();
            other_seed.rseed[3] ^= 0x40;
            let mut other_action = good.clone();
            other_action.action = (good.action + 1) % 3;
            let mut out_of_range = good.clone();
            out_of_range.action = 99;
            let mut other_tx = good.clone();
            other_tx.txid = drop_core::Txid::from_bytes([0x5a; 32]);
            let mut other_version = good.clone();
            other_version.version = 9;
            for failing in [
                bad,
                other_receiver,
                other_seed,
                other_action,
                out_of_range,
                other_tx,
                other_version,
            ] {
                let error = verify_payslip(raw(), &failing).unwrap_err();
                printed.push(format!("{error:?}"));
                printed.push(error.to_string());
                printed.push(format!("{failing:?}"));
            }
        }
        // The issuing side's errors too.
        printed.push(format!("{:?}", IssueError::Unverifiable));
        printed.push(IssueError::Unverifiable.to_string());

        for text in &printed {
            let digits = without_hex_runs(text);
            for j in 0..3 {
                let s = slip(j);
                assert!(
                    !text.contains(&hex::encode(s.receiver)),
                    "receiver in {text}"
                );
                assert!(!text.contains(&hex::encode(s.rseed)), "rseed in {text}");
                assert!(
                    !digits.contains(&s.value.to_string()),
                    "amount {j} in {text}"
                );
            }
            assert!(!text.contains("TEST ONLY"), "memo in {text}");
        }
        assert!(printed.iter().any(|t| t.contains("redacted")));
    }

    // covers: REQ-PAY-001
    #[test]
    fn checking_one_payslip_reads_nothing_of_the_other_outputs() {
        // Spoil every other action's encrypted payload. The transaction id changes (it commits
        // to the ciphertexts); nothing else the check reads does. The payslip still verifies
        // once it names the new id, because the check reads one action's `rho` and `cmx` only.
        let mine = slip(0);
        let tx = inspect::parse(raw()).unwrap();
        let bundle = tx.ironwood_bundle().unwrap();
        let mut spoiled = raw().to_vec();
        for (index, action) in bundle.actions().iter().enumerate() {
            if index == mine.action as usize {
                continue;
            }
            let ciphertext = action.encrypted_note().enc_ciphertext.0;
            let at = spoiled
                .windows(ciphertext.len())
                .position(|w| w == ciphertext)
                .expect("the ciphertext is in the transaction bytes");
            spoiled[at + 100] ^= 0xff;
        }
        let new_txid = ParsedTx::parse(&spoiled).unwrap().txid();
        assert_ne!(new_txid, mine.txid);
        assert_eq!(rejects(&spoiled, &mine), PayslipError::TxidMismatch);
        let mut renamed = mine.clone();
        renamed.txid = new_txid;
        verify_payslip(&spoiled, &renamed).unwrap();
    }

    // covers: REQ-PAY-001
    #[test]
    fn the_transaction_id_commits_to_every_cmx_and_nullifier() {
        // The payslip's tie to one transaction rests on this: change the `cmx` or the nullifier
        // of any action (the two inputs of the check) and the id changes.
        let tx = inspect::parse(raw()).unwrap();
        let bundle = tx.ironwood_bundle().unwrap();
        let original = ParsedTx::parse(raw()).unwrap().txid();
        for action in bundle.actions() {
            for field in [action.cmx().to_bytes(), action.nullifier().to_bytes()] {
                let at = raw()
                    .windows(32)
                    .position(|w| w == field)
                    .expect("the field is in the transaction bytes");
                let mut changed = raw().to_vec();
                changed[at] ^= 1;
                let parsed = ParsedTx::parse(&changed).expect("still a readable transaction");
                assert_ne!(parsed.txid(), original);
            }
        }
    }

    // covers: REQ-PAY-001
    #[test]
    fn a_payslips_rseed_opens_that_outputs_memo_and_no_other() {
        // What a payslip costs its holder to hand over, shown with no viewing key: the `rseed`
        // fixes the note's ephemeral key (ZIP 212), and that key decrypts the action's own
        // ciphertext. The payslip's note is rebuilt exactly as the verifier rebuilds it.
        use orchard::{note::RandomSeed, note_encryption::IronwoodDomain, value::NoteValue};
        use orchard::{Address, NoteVersion};
        use zcash_note_encryption::{try_output_recovery_with_pkd_esk, Domain};

        let tx = inspect::parse(raw()).unwrap();
        let bundle = tx.ironwood_bundle().unwrap();
        let open = |slip: &Payslip, action: usize| {
            let action = &bundle.actions()[action];
            let rho = action.rho();
            let note = Option::<Note>::from(Note::from_parts(
                Option::<Address>::from(Address::from_raw_address_bytes(&slip.receiver)).unwrap(),
                NoteValue::from_raw(slip.value.as_u64()),
                rho,
                Option::<RandomSeed>::from(RandomSeed::from_bytes(slip.rseed, &rho)).unwrap(),
                NoteVersion::V3,
            ))
            .unwrap();
            try_output_recovery_with_pkd_esk(
                &IronwoodDomain::for_action(action),
                IronwoodDomain::get_pk_d(&note),
                IronwoodDomain::derive_esk(&note).unwrap(),
                action,
            )
            .map(|(_, _, memo)| crate::memo::decode_memo(&memo))
        };

        for i in 0..3 {
            let mine = slip(i);
            let memo = open(&mine, mine.action as usize).expect("the rseed opens its own output");
            assert_eq!(
                memo.as_deref(),
                Some(&*format!("TEST ONLY payout {}", i + 1))
            );
            // The same payslip aimed at another action opens nothing.
            for other in (0..3).filter(|a| *a != mine.action as usize) {
                assert!(open(&mine, other).is_none());
            }
        }
    }
}
