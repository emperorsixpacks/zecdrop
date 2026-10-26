//! Fan-out of engine progress events to Server-Sent-Events subscribers.
//!
//! A run publishes into an [`EventHub`]. Each subscriber first receives everything
//! published so far, then live events, and the stream ends after a terminal event
//! (`settled` or `halted`). Events are `drop-core` [`ProgressEvent`]s, which carry
//! batch indices, counts and transaction ids but never recipient data.
//!
//! A `waiting` event that says exactly what the previous one for the same batch said is not
//! published at all: during a wait the engine polls every second or so, and the same sentence a
//! second time tells nobody anything. A change of depth, or any other event for the batch, makes
//! the next `waiting` count again.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use axum::response::sse::Event;
use drop_core::ProgressEvent;
use tokio::sync::{mpsc, watch};
use tokio_stream::wrappers::ReceiverStream;

#[derive(Default)]
struct HubInner {
    events: Vec<(u64, ProgressEvent)>,
    next_seq: u64,
    done: bool,
    /// The last `(observed, required)` depth announced by a `waiting` event, per batch.
    last_waiting: HashMap<u32, (u32, u32)>,
}

/// The batch an event is about, if it is about one.
fn batch_of(event: &ProgressEvent) -> Option<u32> {
    match event {
        ProgressEvent::Built { batch_index, .. }
        | ProgressEvent::Broadcast { batch_index, .. }
        | ProgressEvent::Confirmed { batch_index, .. }
        | ProgressEvent::Waiting { batch_index, .. }
        | ProgressEvent::Failed { batch_index, .. } => Some(*batch_index),
        ProgressEvent::Halted { .. } | ProgressEvent::Settled { .. } => None,
    }
}

/// The event log of one campaign run.
pub struct EventHub {
    inner: Mutex<HubInner>,
    changed: watch::Sender<u64>,
}

impl EventHub {
    /// An empty hub.
    pub fn new() -> Arc<Self> {
        let (changed, _) = watch::channel(0);
        Arc::new(EventHub {
            inner: Mutex::new(HubInner::default()),
            changed,
        })
    }

    fn lock(&self) -> MutexGuard<'_, HubInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Forgets the previous run's events so a new run starts clean.
    pub fn reset(&self) {
        let mut inner = self.lock();
        inner.events.clear();
        inner.last_waiting.clear();
        inner.done = false;
        let seq = inner.next_seq;
        drop(inner);
        self.changed.send_replace(seq);
    }

    /// Appends an event. A `Waiting` event identical to the last one for its batch is dropped;
    /// one that differs replaces a directly preceding `Waiting`, so a long wait does not grow
    /// the log.
    pub fn publish(&self, event: ProgressEvent) {
        let mut inner = self.lock();
        match &event {
            ProgressEvent::Waiting {
                batch_index,
                observed_depth,
                required_depth,
            } => {
                let now = (*observed_depth, *required_depth);
                if inner.last_waiting.get(batch_index) == Some(&now) {
                    return;
                }
                inner.last_waiting.insert(*batch_index, now);
            }
            other => {
                if let Some(batch) = batch_of(other) {
                    inner.last_waiting.remove(&batch);
                }
            }
        }
        let terminal = matches!(
            event,
            ProgressEvent::Settled { .. } | ProgressEvent::Halted { .. }
        );
        let seq = inner.next_seq;
        inner.next_seq += 1;
        let replace_tail = matches!(event, ProgressEvent::Waiting { .. })
            && matches!(
                inner.events.last(),
                Some((_, ProgressEvent::Waiting { .. }))
            );
        if replace_tail {
            inner.events.pop();
        }
        inner.events.push((seq, event));
        if terminal {
            inner.done = true;
        }
        drop(inner);
        self.changed.send_replace(seq);
    }

    /// Events after `last_seq` (all of them for `None`), and whether the run is over.
    pub fn since(&self, last_seq: Option<u64>) -> (Vec<(u64, ProgressEvent)>, bool) {
        let inner = self.lock();
        let events = inner
            .events
            .iter()
            .filter(|(seq, _)| last_seq.is_none_or(|last| *seq > last))
            .cloned()
            .collect();
        (events, inner.done)
    }

    /// A receiver that wakes whenever something is published.
    pub fn watch(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    /// All events so far, without sequence numbers.
    pub fn snapshot(&self) -> Vec<ProgressEvent> {
        self.since(None).0.into_iter().map(|(_, e)| e).collect()
    }
}

fn to_sse(event: &ProgressEvent) -> Event {
    Event::default()
        .event("progress")
        .json_data(event)
        .unwrap_or_else(|_| Event::default().event("progress").data("{}"))
}

/// A stream of SSE messages for `hub`: history first, then live events, ending
/// after the terminal event.
pub fn stream(hub: Arc<EventHub>) -> ReceiverStream<Result<Event, Infallible>> {
    let (tx, rx) = mpsc::channel(64);
    tokio::spawn(async move {
        let mut changes = hub.watch();
        let mut last = None;
        loop {
            let (batch, done) = hub.since(last);
            for (seq, event) in batch {
                last = Some(seq);
                if tx.send(Ok(to_sse(&event))).await.is_err() {
                    return;
                }
            }
            if done {
                return;
            }
            tokio::select! {
                changed = changes.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
                () = tx.closed() => return,
            }
        }
    });
    ReceiverStream::new(rx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use drop_core::{CampaignId, Txid};
    use tokio_stream::StreamExt;

    fn built(i: u32) -> ProgressEvent {
        ProgressEvent::Built {
            batch_index: i,
            txid: Txid::from_bytes([i as u8; 32]),
            outputs: 2,
        }
    }

    fn waiting(i: u32, depth: u32) -> ProgressEvent {
        ProgressEvent::Waiting {
            batch_index: i,
            observed_depth: depth,
            required_depth: 3,
        }
    }

    fn settled() -> ProgressEvent {
        ProgressEvent::Settled {
            campaign_id: CampaignId::new("c").unwrap(),
            batches: 1,
        }
    }

    #[test]
    fn consecutive_waiting_events_collapse_into_the_latest() {
        let hub = EventHub::new();
        hub.publish(built(0));
        for depth in 0..5 {
            hub.publish(waiting(0, depth));
        }
        hub.publish(built(1));
        hub.publish(waiting(1, 0));
        let events = hub.snapshot();
        assert_eq!(events.len(), 4, "{events:?}");
        assert_eq!(events[1], waiting(0, 4));
    }

    #[test]
    fn a_wait_that_says_the_same_thing_again_is_not_published() {
        let hub = EventHub::new();
        hub.publish(built(0));
        hub.publish(waiting(0, 0));
        let seen = hub.since(None).0.last().unwrap().0;
        // Nineteen more polls with nothing new: nothing is published, no sequence number used.
        for _ in 0..19 {
            hub.publish(waiting(0, 0));
        }
        assert_eq!(hub.snapshot(), vec![built(0), waiting(0, 0)]);
        assert!(hub.since(Some(seen)).0.is_empty());
        // The next real event takes the very next sequence number.
        hub.publish(waiting(0, 1));
        assert_eq!(hub.since(Some(seen)).0.first().unwrap().0, seen + 1);
        assert_eq!(hub.snapshot(), vec![built(0), waiting(0, 1)]);
    }

    #[test]
    fn what_counts_as_the_same_wait_is_per_batch_and_ends_with_any_other_event_for_it() {
        let hub = EventHub::new();
        // Two batches polled in turn: each says its first sentence once.
        for _ in 0..3 {
            hub.publish(waiting(0, 0));
            hub.publish(waiting(1, 0));
        }
        assert_eq!(
            hub.snapshot(),
            vec![waiting(1, 0)],
            "the tail waiting replaces the one before"
        );
        let (all, _) = hub.since(None);
        assert_eq!(all.len(), 1);
        assert_eq!(
            hub.since(None).0[0].0,
            1,
            "only two were published: seq 0 and 1"
        );

        // Anything else for the batch (here, a send again) lets its next wait be said again.
        hub.publish(ProgressEvent::Broadcast {
            batch_index: 0,
            txid: Txid::from_bytes([9; 32]),
        });
        hub.publish(waiting(0, 0));
        let kinds: Vec<_> = hub.snapshot().iter().map(|e| e == &waiting(0, 0)).collect();
        assert_eq!(kinds, vec![false, false, true]);
        // A depth that changed and changes back is said each time.
        hub.publish(waiting(0, 1));
        hub.publish(waiting(0, 0));
        assert_eq!(hub.snapshot().last(), Some(&waiting(0, 0)));
        // A new run starts clean.
        hub.reset();
        hub.publish(waiting(0, 0));
        assert_eq!(hub.snapshot(), vec![waiting(0, 0)]);
    }

    #[tokio::test]
    async fn a_live_subscriber_hears_a_long_wait_once() {
        let hub = EventHub::new();
        let mut stream = stream(Arc::clone(&hub));
        hub.publish(waiting(0, 0));
        assert!(stream.next().await.is_some());
        for _ in 0..19 {
            hub.publish(waiting(0, 0));
        }
        hub.publish(settled());
        // The next thing the subscriber receives is the end of the run, not the repeats.
        let rest: Vec<_> = stream.collect().await;
        assert_eq!(rest.len(), 1, "{rest:?}");
    }

    #[test]
    fn since_returns_only_newer_events_and_done_after_a_terminal_one() {
        let hub = EventHub::new();
        hub.publish(built(0));
        let (all, done) = hub.since(None);
        assert_eq!((all.len(), done), (1, false));
        let last = all[0].0;
        assert!(hub.since(Some(last)).0.is_empty());
        hub.publish(settled());
        let (newer, done) = hub.since(Some(last));
        assert_eq!((newer.len(), done), (1, true));
    }

    #[test]
    fn reset_starts_a_new_run_clean() {
        let hub = EventHub::new();
        hub.publish(built(0));
        hub.publish(settled());
        hub.reset();
        assert_eq!(hub.since(None), (vec![], false));
    }

    #[tokio::test]
    async fn a_subscriber_gets_history_then_live_events_then_the_stream_ends() {
        let hub = EventHub::new();
        hub.publish(built(0));
        let mut stream = stream(Arc::clone(&hub));
        let first = stream.next().await.unwrap().unwrap();
        let text = format!("{first:?}");
        assert!(text.contains("progress"), "{text}");

        hub.publish(built(1));
        assert!(stream.next().await.is_some());
        hub.publish(settled());
        assert!(stream.next().await.is_some());
        assert!(
            stream.next().await.is_none(),
            "ends after the terminal event"
        );
    }

    #[tokio::test]
    async fn a_late_subscriber_to_a_finished_run_still_gets_everything() {
        let hub = EventHub::new();
        hub.publish(built(0));
        hub.publish(settled());
        let received: Vec<_> = stream(hub).collect().await;
        assert_eq!(received.len(), 2);
    }
}
