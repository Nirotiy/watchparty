#[derive(Clone, Debug)]
pub struct ClockSync {
    samples: Vec<i64>,
    pub offset_ms: i64,
    jump_guard_ms: i64,
    max_rtt_ms: i64,
}

impl Default for ClockSync {
    fn default() -> Self {
        Self::with_limits(5_000, 1_500)
    }
}
impl ClockSync {
    pub fn new(jump_guard_ms: i64) -> Self {
        Self::with_limits(jump_guard_ms, 1_500)
    }

    pub fn with_limits(jump_guard_ms: i64, max_rtt_ms: i64) -> Self {
        Self {
            samples: Vec::new(),
            offset_ms: 0,
            jump_guard_ms,
            max_rtt_ms,
        }
    }
    pub fn update(&mut self, server_time_ms: i64, sent_ms: i64, received_ms: i64) -> bool {
        let rtt_ms = received_ms.saturating_sub(sent_ms);
        if received_ms < sent_ms || rtt_ms > self.max_rtt_ms {
            return false;
        }
        let sample = server_time_ms - (sent_ms + (received_ms - sent_ms) / 2);
        if !self.samples.is_empty() && (sample - self.offset_ms).abs() > self.jump_guard_ms {
            self.samples.clear();
            return false;
        }
        self.samples.push(sample);
        if self.samples.len() > 5 {
            self.samples.remove(0);
        }
        let mut sorted = self.samples.clone();
        sorted.sort_unstable();
        self.offset_ms = sorted[sorted.len() / 2];
        true
    }
    pub fn estimate_server_time(&self, local_ms: i64) -> i64 {
        local_ms + self.offset_ms
    }
    pub fn sample_count(&self) -> usize {
        self.samples.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uses_midpoint_median_and_rejects_clock_jumps() {
        let mut clock = ClockSync::new(1000);
        assert!(clock.update(1050, 1000, 1100));
        assert!(clock.update(2055, 2000, 2100));
        assert!(clock.update(3045, 3000, 3100));
        assert_eq!(clock.offset_ms, 0);
        assert!(!clock.update(20_000, 4000, 4100));
        assert_eq!(clock.sample_count(), 0);
        assert!(!clock.update(5_000, 4_000, 6_000));
        assert_eq!(clock.sample_count(), 0);
    }
}
