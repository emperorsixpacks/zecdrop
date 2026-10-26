//! End-to-end check through the public API only: CSV -> manifest -> plan -> engine
//! -> public receipt, with a scripted distributor and an in-memory ledger.

use std::collections::HashMap;

use drop_core::codec::PermissiveCodec;
use drop_core::{
    derive_phase, import_csv_str, plan_batches, privacy_warnings, total_amount, BatchStatus,
    BuiltBatch, CampaignId, CampaignPhase, Distributor, Engine, FeePolicy, FundingRef,
    FundingState, ImportOptions, InMemoryLedger, Ledger, Manifest, Network, OutPoint, Pool,
    ProgressEvent, PublicReceipt, ReceiptInputs, Salt, Txid, Zatoshi,
};

#[derive(Debug, thiserror::Error)]
#[error("scripted node failure")]
struct NodeError;

/// Builds deterministic transactions and confirms them on demand.
#[derive(Default)]
struct ScriptedNode {
    builds: u32,
    depth: HashMap<Txid, u32>,
}

impl Distributor for ScriptedNode {
    type Error = NodeError;

    fn build_batch(
        &mut self,
        batch: &drop_core::Batch,
        _funding: &FundingRef,
    ) -> Result<BuiltBatch, NodeError> {
        self.builds += 1;
        let byte = u8::try_from(batch.index()).unwrap_or(0) + 1;
        Ok(BuiltBatch {
            txid: Txid::from_bytes([byte; 32]),
            raw_tx: vec![byte],
        })
    }

    fn broadcast(&mut self, built: &BuiltBatch) -> Result<(), NodeError> {
        self.depth.entry(built.txid).or_insert(0);
        Ok(())
    }

    fn confirmations(&mut self, txid: &Txid) -> Result<Option<u32>, NodeError> {
        Ok(self.depth.get(txid).copied())
    }
}

const CSV: &str = "\u{feff}Address;Amount;Memo\r\n\
u1pipelinealice0000000001;12.5;\"welcome, alice\"\r\n\
u1pipelinebob000000000002;0.75;\r\n\
zs1pipelinecarol0000000003;3;thanks\r\n\
u1pipelinedave00000000004;1.125;\r\n\
u1pipelineerin00000000005;8;\r\n";

#[test]
fn csv_to_settled_receipt() {
    // Import.
    let report = import_csv_str(CSV, &PermissiveCodec, &ImportOptions::default());
    assert!(report.is_clean(), "{:?}", report.errors);
    let rows = report.rows;
    assert_eq!(rows.len(), 5);
    let total = total_amount(&rows).unwrap();
    assert_eq!(total.format_zec(), "25.375");

    // Commit to the private manifest, then plan.
    let campaign = CampaignId::new("payout-test").unwrap();
    let manifest =
        Manifest::new(campaign.clone(), Salt::generate().unwrap(), rows.clone()).unwrap();
    let commitment = manifest.commitment();
    assert!(manifest.verify_commitment(&commitment).is_ok());

    let batches = plan_batches(&rows, 3).unwrap();
    assert_eq!(
        batches.iter().map(|b| b.len()).collect::<Vec<_>>(),
        vec![3, 2]
    );
    assert!(privacy_warnings(&batches)
        .iter()
        .all(|w| !w.to_string().contains("pipeline")));

    // One funding output per batch, sized for total + fee.
    let fundings: Vec<FundingRef> = batches
        .iter()
        .map(|b| FundingRef {
            outpoint: OutPoint {
                txid: Txid::from_bytes([0xee; 32]),
                vout: b.index(),
            },
            value: Zatoshi::new(b.total().as_u64() + 100_000).unwrap(),
        })
        .collect();

    let fee_policy = FeePolicy::zip317_text();

    // Run, "crashing" after every single step by rebuilding the engine from the ledger.
    let mut node = ScriptedNode::default();
    let mut ledger = InMemoryLedger::new();
    let mut guard = 0;
    loop {
        guard += 1;
        assert!(guard < 50, "engine did not settle");
        let mut engine = Engine::new(
            campaign.clone(),
            batches.clone(),
            fundings.clone(),
            2,
            &fee_policy,
            &mut node,
            &mut ledger,
        )
        .unwrap();
        let event = engine.step().unwrap();
        drop(engine);
        match event {
            ProgressEvent::Settled { batches, .. } => {
                assert_eq!(batches, 2);
                break;
            }
            ProgressEvent::Waiting { .. } => {
                // The chain advances: every broadcast transaction gains a confirmation.
                for depth in node.depth.values_mut() {
                    *depth += 1;
                }
            }
            _ => {}
        }
    }
    assert_eq!(
        node.builds, 2,
        "each batch was built exactly once across all restarts"
    );

    // Public receipt: totals and ids, nothing about recipients.
    let statuses = ledger.statuses(&campaign, 2).unwrap();
    assert!(statuses
        .iter()
        .all(|s| matches!(s, BatchStatus::Confirmed { depth, .. } if *depth >= 2)));
    assert_eq!(
        derive_phase(FundingState::Funded, &statuses, 2),
        CampaignPhase::Settled
    );
    let receipt = PublicReceipt::assemble(ReceiptInputs {
        campaign_id: &campaign,
        network: Network::Testnet,
        manifest_commitment: commitment,
        fee_policy: &fee_policy,
        pool: Pool::Ironwood,
        batches: &batches,
        fundings: &fundings,
        statuses: &statuses,
        funding_state: FundingState::Funded,
        required_depth: 2,
        funding_address: None,
        funding_source: None,
    })
    .unwrap();
    assert_eq!(receipt.declared_total, total);
    assert_eq!(receipt.phase, CampaignPhase::Settled);

    let json = serde_json::to_string(&receipt).unwrap();
    for secret in [
        "u1pipeline",
        "zs1pipeline",
        "alice",
        "welcome",
        "thanks",
        "1250000000",
        "75000000",
    ] {
        assert!(!json.contains(secret), "{secret} leaked: {json}");
    }
    assert!(json.contains(&commitment.to_string()));
}
