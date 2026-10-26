//! When an inbox moves, and what it says while it waits (REQ-FUND-006, REQ-FUND-008). No I/O: the engine gathers the facts
//! and does what this decides.
//!
//! zcash-devtool spends a note from outside after 10 confirmations, its own change after 3, and pays the ZIP 317 fee: 5,000
//! zatoshi for each logical action, at least 2. A move spends `n` Ironwood notes (at least 2 actions, as a bundle pads to
//! two) and pays one transparent output, so its fee is 5,000 × (max(2, n) + 1): 15,000 for one or two notes. Change is
//! one note back to the inbox, unless it is under the 5,000 the dust rule needs, in which case zcash-devtool refuses to build.

use drop_core::fee::FeePolicy;

/// Confirmations a note from outside needs before zcash-devtool spends it.
pub const SPENDABLE_AFTER: u32 = 10;
/// Confirmations the inbox's own change needs.
pub const CHANGE_SPENDABLE_AFTER: u32 = 3;
/// The smallest change zcash-devtool will make: anything less is refused as dust.
pub const MIN_CHANGE: u64 = 5_000;

/// The fee of a move spending `notes` Ironwood notes into one transparent output (and at most one change note).
pub fn move_fee(notes: usize) -> u64 {
    let policy = FeePolicy::zip317_text();
    let actions = u64::try_from(notes.max(2))
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    policy
        .marginal_fee
        .saturating_mul(actions.max(u64::from(policy.grace_actions)))
}

/// What the payer is asked to send to the inbox for a payout needing `required`: the funding and the fee of a one-note move.
pub fn asked(required: u64) -> u64 {
    required.saturating_add(move_fee(1))
}

/// One note the inbox holds, as the planner needs it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Held {
    /// Its value, in zatoshi.
    pub value: u64,
    /// Its confirmations at the wallet's scanned tip (0 while unmined).
    pub confirmations: u32,
    /// The inbox's own change, which zcash-devtool trusts sooner.
    pub is_change: bool,
    /// Not spent by a transaction that is mined or still could be.
    pub unspent: bool,
}

impl Held {
    fn spendable(&self) -> bool {
        self.unspent
            && self.confirmations
                >= if self.is_change {
                    CHANGE_SPENDABLE_AFTER
                } else {
                    SPENDABLE_AFTER
                }
    }
}

/// What the inbox holds, summed for the screen.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Holdings {
    /// Every unspent note, confirmed or not.
    pub received: u64,
    /// What zcash-devtool can spend now.
    pub spendable: u64,
    /// The fewest confirmations of an unspent note that is not spendable yet, if any.
    pub confirming: Option<u32>,
}

/// Sums what the inbox holds.
pub fn holdings(notes: &[Held]) -> Holdings {
    let mut out = Holdings::default();
    for note in notes.iter().filter(|n| n.unspent) {
        out.received = out.received.saturating_add(note.value);
        if note.spendable() {
            out.spendable = out.spendable.saturating_add(note.value);
        } else {
            out.confirming = Some(
                out.confirming
                    .map_or(note.confirmations, |c| c.min(note.confirmations)),
            );
        }
    }
    out
}

/// What to do about an inbox now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plan {
    /// Nothing to move: the payout is funded another way, or the inbox has already moved, or a transaction is in flight.
    Hold,
    /// Nothing has arrived yet.
    Empty,
    /// Notes have arrived and are confirming.
    Confirming,
    /// What is spendable (and what is still confirming) falls short.
    Short {
        /// How many more zatoshi the payer must send.
        need: u64,
    },
    /// Enough is spendable, but the change would be under the dust limit: send `MIN_CHANGE - over` more, or send it back.
    Dust {
        /// The change it would leave, in zatoshi.
        over: u64,
    },
    /// Enough is spendable: move.
    Move {
        /// How many notes the move spends.
        notes: usize,
        /// Its fee, as [`move_fee`] gives it for that many notes.
        fee: u64,
    },
}

/// Facts about the payout the planner needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Payout {
    /// What the payout's funding address must receive.
    pub required: u64,
    /// The payout is funded, or a big enough deposit has been seen at its funding address.
    pub funded_otherwise: bool,
    /// A move or a send-back is in flight, or a move is already mined.
    pub busy_or_moved: bool,
}

/// Decides what to do. Notes are taken largest first, as zcash-devtool's greedy selector does, until they cover the
/// funding and the fee of spending that many.
pub fn plan(payout: Payout, notes: &[Held]) -> Plan {
    if payout.funded_otherwise || payout.busy_or_moved {
        return Plan::Hold;
    }
    let held = holdings(notes);
    if held.received == 0 {
        return Plan::Empty;
    }
    let mut spendable: Vec<u64> = notes
        .iter()
        .filter(|n| n.spendable())
        .map(|n| n.value)
        .collect();
    spendable.sort_unstable_by(|a, b| b.cmp(a));
    let mut sum = 0u64;
    for (taken, value) in spendable.iter().enumerate() {
        sum = sum.saturating_add(*value);
        let count = taken + 1;
        let fee = move_fee(count);
        let cost = payout.required.saturating_add(fee);
        if sum >= cost {
            let change = sum - cost;
            return if change == 0 || change >= MIN_CHANGE {
                Plan::Move { notes: count, fee }
            } else if count < spendable.len() {
                // Another note would lift the change over the limit; the next round, with it, decides.
                continue_with_more(&spendable, count, payout.required)
            } else {
                Plan::Dust { over: change }
            };
        }
    }
    // Not enough is spendable. If the notes still confirming would make it, say so; otherwise say what is missing.
    let all = held.received;
    let cost = payout
        .required
        .saturating_add(move_fee(notes.iter().filter(|n| n.unspent).count().max(1)));
    // Enough once the rest confirms, or nothing spendable yet to judge by: confirming. Otherwise, what is missing.
    if all >= cost || (held.confirming.is_some() && held.spendable == 0) {
        Plan::Confirming
    } else {
        Plan::Short { need: cost - all }
    }
}

/// With `count` notes the change was dust; tries one more note at a time.
fn continue_with_more(spendable: &[u64], count: usize, required: u64) -> Plan {
    let mut sum: u64 = spendable[..count].iter().sum();
    for (taken, value) in spendable.iter().enumerate().skip(count) {
        sum = sum.saturating_add(*value);
        let fee = move_fee(taken + 1);
        let change = sum.saturating_sub(required.saturating_add(fee));
        if change == 0 || change >= MIN_CHANGE {
            return Plan::Move {
                notes: taken + 1,
                fee,
            };
        }
    }
    Plan::Dust {
        over: sum.saturating_sub(required.saturating_add(move_fee(spendable.len()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(value: u64, confirmations: u32) -> Held {
        Held {
            value,
            confirmations,
            is_change: false,
            unspent: true,
        }
    }

    const NEEDED: Payout = Payout {
        required: 115_000,
        funded_otherwise: false,
        busy_or_moved: false,
    };

    #[test]
    fn the_fee_is_zip_317_for_the_moves_shape() {
        assert_eq!(move_fee(1), 15_000);
        assert_eq!(move_fee(2), 15_000);
        assert_eq!(move_fee(3), 20_000);
        assert_eq!(asked(115_000), 130_000);
    }

    #[test]
    fn exactly_what_was_asked_moves_once_it_is_spendable() {
        assert_eq!(plan(NEEDED, &[]), Plan::Empty);
        assert_eq!(plan(NEEDED, &[note(130_000, 0)]), Plan::Confirming);
        assert_eq!(plan(NEEDED, &[note(130_000, 9)]), Plan::Confirming);
        assert_eq!(
            plan(NEEDED, &[note(130_000, 10)]),
            Plan::Move {
                notes: 1,
                fee: 15_000
            }
        );
    }

    #[test]
    fn too_little_says_how_much_more() {
        assert_eq!(
            plan(NEEDED, &[note(100_000, 12)]),
            Plan::Short { need: 30_000 }
        );
        // Two parts that add up are fine, and cost no more for two notes than for one.
        assert_eq!(
            plan(NEEDED, &[note(100_000, 12), note(30_000, 11)]),
            Plan::Move {
                notes: 2,
                fee: 15_000
            }
        );
        // A third part makes three notes, which cost 5,000 more.
        assert_eq!(
            plan(
                NEEDED,
                &[note(60_000, 12), note(40_000, 12), note(30_000, 12)]
            ),
            Plan::Short { need: 5_000 }
        );
    }

    #[test]
    fn change_under_the_dust_limit_cannot_be_built() {
        assert_eq!(plan(NEEDED, &[note(130_003, 10)]), Plan::Dust { over: 3 });
        assert_eq!(
            plan(NEEDED, &[note(135_000, 10)]),
            Plan::Move {
                notes: 1,
                fee: 15_000
            }
        );
    }

    #[test]
    fn a_payout_funded_another_way_or_already_moving_is_never_moved() {
        let notes = [note(130_000, 50)];
        assert_eq!(
            plan(
                Payout {
                    funded_otherwise: true,
                    ..NEEDED
                },
                &notes
            ),
            Plan::Hold
        );
        assert_eq!(
            plan(
                Payout {
                    busy_or_moved: true,
                    ..NEEDED
                },
                &notes
            ),
            Plan::Hold
        );
    }

    #[test]
    fn spent_notes_count_for_nothing_and_change_is_spendable_sooner() {
        let spent = Held {
            value: 500_000,
            confirmations: 40,
            is_change: false,
            unspent: false,
        };
        assert_eq!(plan(NEEDED, &[spent]), Plan::Empty);
        let change = Held {
            value: 130_000,
            confirmations: 3,
            is_change: true,
            unspent: true,
        };
        assert_eq!(
            plan(NEEDED, &[change]),
            Plan::Move {
                notes: 1,
                fee: 15_000
            }
        );
        let held = holdings(&[spent, change, note(7, 2)]);
        assert_eq!(
            (held.received, held.spendable, held.confirming),
            (130_007, 130_000, Some(2))
        );
    }
}
