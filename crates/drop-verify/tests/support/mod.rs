//! Shared test support: the generator, fixture files and a fake chain.
#![allow(dead_code)]

pub mod builder;

use std::collections::HashMap;
use std::path::PathBuf;

use drop_core::Txid;
use drop_verify::{ChainSource, FetchedTx, SourceError};
use serde_json::{json, Value};

/// A stored fixture: a batch transaction and the funding transaction it spends.
#[derive(Clone)]
pub struct Fixture {
    pub name: String,
    pub batch_raw: Vec<u8>,
    pub batch_txid: Txid,
    pub funding_raw: Vec<u8>,
    pub funding_txid: Txid,
    pub payout_total: u64,
    pub fee: u64,
    pub change: u64,
    pub height: u32,
}

pub fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(format!("{name}.json"))
}

fn display_txid(hex_text: &str) -> Txid {
    hex_text.parse().unwrap()
}

pub fn to_json(description: &str, pool: &str, g: &builder::Generated) -> Value {
    json!({
        "description": description,
        "network": "testnet",
        "pool": pool,
        "height": g.height,
        "txid": g.batch_txid_display,
        "raw_hex": hex::encode(&g.batch_raw),
        "funding": { "txid": g.funding_txid_display, "raw_hex": hex::encode(&g.funding_raw) },
        "payout_total": g.payout_total.to_string(),
        "fee": g.fee.to_string(),
        "change": g.change.to_string(),
    })
}

pub fn load(name: &str) -> Fixture {
    let path = fixture_path(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read fixture {}: {e}. Generate with UPDATE_FIXTURES=1 cargo test -p drop-verify --test generate_fixtures -- --ignored", path.display()));
    let v: Value = serde_json::from_str(&text).unwrap();
    let s = |value: &Value| value.as_str().unwrap().to_owned();
    let n = |value: &Value| s(value).parse::<u64>().unwrap();
    Fixture {
        name: name.to_owned(),
        batch_raw: hex::decode(s(&v["raw_hex"])).unwrap(),
        batch_txid: display_txid(&s(&v["txid"])),
        funding_raw: hex::decode(s(&v["funding"]["raw_hex"])).unwrap(),
        funding_txid: display_txid(&s(&v["funding"]["txid"])),
        payout_total: n(&v["payout_total"]),
        fee: n(&v["fee"]),
        change: n(&v["change"]),
        height: v["height"].as_u64().unwrap() as u32,
    }
}

/// An in-memory chain.
#[derive(Clone, Default)]
pub struct FakeChain {
    pub txs: HashMap<Txid, FetchedTx>,
    pub tip: u32,
    pub down: bool,
    /// Lie about transaction ids: answer every lookup with this raw transaction.
    pub always_answer_with: Option<Vec<u8>>,
}

impl FakeChain {
    pub fn with(fixture: &Fixture, mined_height: Option<u32>, tip: u32) -> FakeChain {
        let mut chain = FakeChain {
            tip,
            ..FakeChain::default()
        };
        chain.txs.insert(
            fixture.funding_txid,
            FetchedTx {
                raw: fixture.funding_raw.clone(),
                mined_height: Some(1),
            },
        );
        chain.txs.insert(
            fixture.batch_txid,
            FetchedTx {
                raw: fixture.batch_raw.clone(),
                mined_height,
            },
        );
        chain
    }
}

impl ChainSource for FakeChain {
    async fn transaction(&self, txid: &Txid) -> Result<Option<FetchedTx>, SourceError> {
        if self.down {
            return Err(SourceError::Unavailable);
        }
        if let Some(raw) = &self.always_answer_with {
            return Ok(Some(FetchedTx {
                raw: raw.clone(),
                mined_height: Some(1),
            }));
        }
        Ok(self.txs.get(txid).cloned())
    }

    async fn tip_height(&self) -> Result<u32, SourceError> {
        if self.down {
            return Err(SourceError::Unavailable);
        }
        Ok(self.tip)
    }
}
