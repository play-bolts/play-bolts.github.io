//! Bounded wall-clock accounting for a fixed-step authority. Timer wakeups are
//! merely opportunities to do work, not proof that exactly one tick elapsed.
use std::time::Duration;

pub const STEP: Duration = Duration::from_nanos(16_666_667);
const MAX_BATCH: u32 = 8;
const MAX_DEBT: u32 = 30;

#[derive(Default)]
pub struct TickClock {
    debt: Duration,
}

#[derive(Debug, PartialEq, Eq)]
pub struct TickBatch {
    pub steps: u32,
    pub pending: u32,
    pub dropped: u64,
}

impl TickClock {
    pub fn advance(&mut self, elapsed: Duration) -> TickBatch {
        self.debt = self.debt.saturating_add(elapsed);
        let maximum = STEP * MAX_DEBT;
        let dropped = self.debt.saturating_sub(maximum).as_nanos() / STEP.as_nanos();
        // Preserve the sub-tick remainder when discarding a severe overload.
        if dropped > 0 {
            self.debt -= Duration::from_nanos((dropped * STEP.as_nanos()) as u64);
        }
        let due = (self.debt.as_nanos() / STEP.as_nanos()) as u32;
        let steps = due.min(MAX_BATCH);
        self.debt -= STEP * steps;
        TickBatch {
            steps,
            pending: due - steps,
            dropped: dropped as u64,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn early_wakes_do_not_speed_the_game_up() {
        let mut clock = TickClock::default();
        assert_eq!(clock.advance(STEP / 2).steps, 0);
        assert_eq!(clock.advance(STEP - STEP / 2).steps, 1);
        assert_eq!(clock.advance(Duration::ZERO).steps, 0);
    }

    #[test]
    fn ordinary_stall_recovers_all_steps_in_bounded_batches() {
        let mut clock = TickClock::default();
        let first = clock.advance(STEP * 15);
        assert_eq!(
            first,
            TickBatch {
                steps: 8,
                pending: 7,
                dropped: 0
            }
        );
        let second = clock.advance(STEP);
        assert_eq!(
            second,
            TickBatch {
                steps: 8,
                pending: 0,
                dropped: 0
            }
        );
        assert_eq!(clock.advance(Duration::ZERO).steps, 0);
    }

    #[test]
    fn severe_overload_is_bounded_and_accounted_for() {
        let mut clock = TickClock::default();
        let batch = clock.advance(STEP * 600 + STEP / 2);
        assert_eq!(
            batch,
            TickBatch {
                steps: 8,
                pending: 22,
                dropped: 570
            }
        );
        let mut recovered = batch.steps;
        for _ in 0..3 {
            recovered += clock.advance(Duration::ZERO).steps;
        }
        assert_eq!(recovered, 30);
        assert_eq!(clock.advance(STEP - STEP / 2).steps, 1);
    }
}
