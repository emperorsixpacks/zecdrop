//! When an inbox moves, and what it says while it waits (REQ-FUND-006, REQ-FUND-008). No I/O: the engine gathers the facts
//! and does what this decides.
//!
//! zcash-devtool spends a note from outside after 10 confirmations, its own change after 3, and pays the ZIP 317 fee: 5,000
//! zatoshi for each logical action, at least 2. A move spends `n` Ironwood notes (at least 2 actions, as a bundle pads to
//! two) and pays one transparent output, so its fee is 5,000 × (max(2, n) + 1): 15,000 for one or two notes. Change is
//! one note back to the inbox, unless it is under the 5,000 the dust rule needs, in which case zcash-devtool refuses to build.
//! And it never spends a note worth 5,000 or less (its wallet does not pick one, for a move or a send-back), so such a note
//! counts for nothing here, and no payment asked for is ever that small.

use drop_core::fee::FeePolicy;

/// Confirmations a note from outside needs before zcash-devtool spends it.
pub const SPENDABLE_AFTER: u32 = 10;
/// Confirmations the inbox's own change needs.
pub const CHANGE_SPENDABLE_AFTER: u32 = 3;
/// The smallest change zcash-devtool will make: anything less is refused as dust.
pub const MIN_CHANGE: u64 = 5_000;
/// zcash-devtool spends only notes worth more than this (the ZIP 317 marginal fee, which spending one costs).
pub const SPENDABLE_ABOVE: u64 = 5_000;

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
    /// Unspent and worth more than [`SPENDABLE_ABOVE`]: a note zcash-devtool will spend, once it is confirmed.
    fn usable(&self) -> bool {
        self.unspent && self.value > SPENDABLE_ABOVE
    }

    fn spendable(&self) -> bool {
        self.usable()
            && self.confirmations
                >= if self.is_change {
                    CHANGE_SPENDABLE_AFTER
                } else {
                    SPENDABLE_AFTER
                }
    }
}

/// What the inbox holds, summed for the screen: notes worth spending only (see [`SPENDABLE_ABOVE`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Holdings {
    /// Every unspent note worth spending, confirmed or not.
    pub received: u64,
    /// What zcash-devtool can spend now.
    pub spendable: u64,
    /// The fewest confirmations of an unspent note that is not spendable yet, if any.
    pub confirming: Option<u32>,
}

/// Sums what the inbox holds.
pub fn holdings(notes: &[Held]) -> Holdings {
    let mut out = Holdings::default();
    for note in notes.iter().filter(|n| n.usable()) {
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
        /// The one more payment that makes a move possible, in zatoshi.
        need: u64,
    },
    /// Enough is spendable, but the change would be under the dust limit: send `need` more, or send it back.
    Dust {
        /// The one more payment that makes a move possible, in zatoshi.
        need: u64,
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
                Plan::Dust {
                    need: dust_top_up(change, count),
                }
            };
        }
    }
    // Not enough is spendable. If the notes still confirming would make it, say so; otherwise say what is missing.
    let all = held.received;
    let usable = notes.iter().filter(|n| n.usable()).count();
    let cost = payout.required.saturating_add(move_fee(usable.max(1)));
    // Enough once the rest confirms, or nothing spendable yet to judge by: confirming. Otherwise, what is missing.
    if all >= cost || (held.confirming.is_some() && held.spendable == 0) {
        Plan::Confirming
    } else {
        Plan::Short {
            need: top_up(payout.required, all, usable),
        }
    }
}

/// The one payment that makes a move possible when the inbox's `count` usable notes, worth `held`, fall short of
/// `required`. It is one more note, so the fee is that of `count + 1` notes; it must be worth more than [`SPENDABLE_ABOVE`],
/// or zcash-devtool would never spend it; and it must leave no change, or at least [`MIN_CHANGE`]. Every usable note is worth
/// more than the 5,000 one more note adds to the fee, so a move with it spends every note.
fn top_up(required: u64, held: u64, count: usize) -> u64 {
    let exact = required
        .saturating_add(move_fee(count + 1))
        .saturating_sub(held);
    if exact > SPENDABLE_ABOVE {
        exact
    } else {
        exact.saturating_add(MIN_CHANGE)
    }
}

/// The one payment that lets a move be made when `count` spendable notes cover it but leave `over` of change, under
/// [`MIN_CHANGE`]: worth more than [`SPENDABLE_ABOVE`], and lifting the change, less the fee of one more note, to at least
/// [`MIN_CHANGE`].
fn dust_top_up(over: u64, count: usize) -> u64 {
    let extra_fee = move_fee(count + 1).saturating_sub(move_fee(count));
    MIN_CHANGE
        .saturating_add(extra_fee)
        .saturating_sub(over)
        .max(SPENDABLE_ABOVE + 1)
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
        need: dust_top_up(
            sum.saturating_sub(required.saturating_add(move_fee(spendable.len()))),
            spendable.len(),
        ),
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
        // A third part makes three notes, which cost 5,000 more; and what fills the gap is a fourth, which costs 5,000 more
        // again.
        assert_eq!(
            plan(
                NEEDED,
                &[note(60_000, 12), note(40_000, 12), note(30_000, 12)]
            ),
            Plan::Short { need: 10_000 }
        );
    }

    #[test]
    fn change_under_the_dust_limit_cannot_be_built() {
        // 3 of change can't be made; one more payment of over 5,000 makes it change that can.
        assert_eq!(
            plan(NEEDED, &[note(130_003, 10)]),
            Plan::Dust { need: 5_001 }
        );
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
        let held = holdings(&[spent, change, note(7_000, 2)]);
        assert_eq!(
            (held.received, held.spendable, held.confirming),
            (137_000, 130_000, Some(2))
        );
    }

    #[test]
    fn a_note_of_5000_or_less_counts_for_nothing_and_is_never_asked_for() {
        // zcash-devtool never spends one, so it is not received, spendable or confirming here.
        assert_eq!(plan(NEEDED, &[note(5_000, 50)]), Plan::Empty);
        assert_eq!(
            holdings(&[note(5_000, 50), note(1, 2)]),
            Holdings::default()
        );
        // 126,000 is 4,000 short of what was asked; 4,000 would be such a note. 9,000 is not, and leaves 5,000 of change.
        let notes = [note(126_000, 12), note(4_000, 12)];
        assert_eq!(plan(NEEDED, &notes), Plan::Short { need: 9_000 });
        assert_eq!(
            plan(
                NEEDED,
                &[note(126_000, 12), note(4_000, 12), note(9_000, 10)]
            ),
            Plan::Move {
                notes: 2,
                fee: 15_000
            }
        );
    }

    #[test]
    fn whatever_is_asked_for_makes_a_move_possible_once_paid() {
        for required in [115_000, 545_000] {
            let payout = Payout { required, ..NEEDED };
            for held in (6_000..required + 40_000).step_by(997) {
                // What is there in one note, in two, or in three (each worth spending).
                let shapes = [
                    vec![held],
                    vec![held / 2 + 5_001, held / 2],
                    vec![held / 3 + 5_002, held / 3, held / 3],
                ];
                for shape in shapes
                    .iter()
                    .filter(|s| s.iter().all(|v| *v > SPENDABLE_ABOVE))
                {
                    let mut notes: Vec<Held> = shape.iter().map(|v| note(*v, 12)).collect();
                    let need = match plan(payout, &notes) {
                        Plan::Short { need } | Plan::Dust { need } => need,
                        Plan::Move { .. } => continue,
                        other => panic!("{required} {shape:?}: {other:?}"),
                    };
                    assert!(
                        need > SPENDABLE_ABOVE,
                        "{required} {shape:?}: asked for {need}"
                    );
                    notes.push(note(need, 10));
                    assert!(
                        matches!(plan(payout, &notes), Plan::Move { .. }),
                        "{required} {shape:?} + {need}: {:?}",
                        plan(payout, &notes)
                    );
                }
            }
        }
    }
}
