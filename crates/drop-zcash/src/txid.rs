//! Byte-order bridging: `drop_core::Txid` keeps *display* order (what explorers print), while
//! librustzcash's `TxId` keeps the *internal* (hashed) order. They are byte reversals of each other.

use zcash_primitives::transaction::TxId;

pub(crate) fn to_core(txid: &TxId) -> drop_core::Txid {
    let mut bytes = *txid.as_ref();
    bytes.reverse();
    drop_core::Txid::from_bytes(bytes)
}

pub(crate) fn from_core(txid: &drop_core::Txid) -> TxId {
    let mut bytes = *txid.as_bytes();
    bytes.reverse();
    TxId::from_bytes(bytes)
}

pub(crate) fn outpoint_from_core(op: &drop_core::OutPoint) -> zcash_transparent::bundle::OutPoint {
    zcash_transparent::bundle::OutPoint::new(*from_core(&op.txid).as_ref(), op.vout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_txid_displays_like_librustzcash() {
        let internal = TxId::from_bytes(std::array::from_fn(|i| i as u8));
        let core = to_core(&internal);
        assert_eq!(core.to_string(), internal.to_string());
        assert_eq!(from_core(&core), internal);
    }
}
