use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Arc, Mutex},
};

pub(crate) const CONNECTIONS_PER_IP: usize = 12;
pub(crate) const SEATS_PER_IP: usize = 4;

/// Equivalent IPv6 spellings and IPv4-mapped IPv6 share every IP quota.
pub(crate) fn canonical_ip(value: &str) -> String {
    match value.parse::<IpAddr>() {
        Ok(IpAddr::V6(ip)) => ip
            .to_ipv4_mapped()
            .map_or_else(|| ip.to_string(), |v4| v4.to_string()),
        Ok(ip) => ip.to_string(),
        Err(_) => "unknown".into(),
    }
}

#[derive(Default)]
pub(crate) struct ConnectionLimits(Mutex<HashMap<String, usize>>);
pub(crate) struct ConnectionPermit {
    limits: Arc<ConnectionLimits>,
    ip: String,
}
impl ConnectionLimits {
    /// The permit moves into the upgrade callback, so a failed upgrade,
    /// authentication rejection, cancellation or disconnect releases it.
    pub(crate) fn acquire(self: &Arc<Self>, ip: &str) -> Option<ConnectionPermit> {
        let ip = canonical_ip(ip);
        let mut counts = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let count = counts.entry(ip.clone()).or_default();
        if *count >= CONNECTIONS_PER_IP {
            return None;
        }
        *count += 1;
        Some(ConnectionPermit {
            limits: self.clone(),
            ip,
        })
    }
    #[cfg(test)]
    pub(crate) fn active(&self, ip: &str) -> usize {
        self.0
            .lock()
            .unwrap()
            .get(&canonical_ip(ip))
            .copied()
            .unwrap_or(0)
    }
}
impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        let mut counts = self
            .limits
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(count) = counts.get_mut(&self.ip) {
            *count -= 1;
            if *count == 0 {
                counts.remove(&self.ip);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permits_are_shared_by_canonical_ip_and_released_without_retained_keys() {
        let limits = Arc::new(ConnectionLimits::default());
        let permits: Vec<_> = (0..CONNECTIONS_PER_IP)
            .map(|_| limits.acquire("192.0.2.1").unwrap())
            .collect();
        assert!(limits.acquire("::ffff:c000:201").is_none());
        let other = limits.acquire("192.0.2.2").unwrap();
        assert_eq!(limits.active("192.0.2.2"), 1);
        drop(permits);
        drop(other);
        assert!(limits.0.lock().unwrap().is_empty());
        assert_eq!(
            canonical_ip("2001:0db8:0:0:0:0:0:1"),
            canonical_ip("2001:db8::1")
        );
    }
}
