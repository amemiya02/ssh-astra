//! A read-only snapshot stream on an already authenticated Connection.

use std::collections::{BTreeMap, HashSet};
use std::str;
use std::time::Duration;

use russh::{Channel, ChannelMsg, Sig};
use serde::{Deserialize, Serialize};
use tokio::sync::{oneshot, watch};
use tokio::time::{sleep_until, timeout, Instant};

use crate::ssh::{shell_quote, Connection};

const SAMPLE_TIMEOUT: Duration = Duration::from_secs(6);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_FRAME_BYTES: usize = 64 * 1024;
const MAX_INTERFACES: usize = 512;
const MAX_MOUNTS: usize = 5;
const SAMPLER: &str = include_str!("sampler.sh");

type Session = Channel<russh::client::Msg>;

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(try_from = "u8")]
pub enum ResourceInterval {
    OneSecond = 1,
    #[default]
    TwoSeconds = 2,
    FiveSeconds = 5,
}

impl TryFrom<u8> for ResourceInterval {
    type Error = &'static str;

    fn try_from(seconds: u8) -> Result<Self, Self::Error> {
        match seconds {
            1 => Ok(Self::OneSecond),
            2 => Ok(Self::TwoSeconds),
            5 => Ok(Self::FiveSeconds),
            _ => Err("resource sampling interval must be 1, 2, or 5 seconds"),
        }
    }
}

impl ResourceInterval {
    fn duration(self) -> Duration {
        Duration::from_secs(self as u64)
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ResourceEvent {
    Snapshot { snapshot: ResourceSnapshot },
    Unsupported,
    Unavailable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    pub cpu_percent: Option<f64>,
    pub cores: u32,
    pub load: [f64; 3],
    pub memory: Usage,
    pub swap: Usage,
    pub disks: Vec<DiskUsage>,
    pub network: Vec<NetworkRate>,
    pub uptime_seconds: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Usage {
    pub used: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiskUsage {
    pub mount: String,
    #[serde(flatten)]
    pub usage: Usage,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkRate {
    pub name: String,
    pub receive_rate: Option<f64>,
    pub send_rate: Option<f64>,
}

/// Runs the fixed sampler until stopped or the consumer stops accepting events.
/// Dropping the stop sender has the same effect as sending it.
/// Interval updates adjust the next deadline without interrupting a sample.
pub async fn watch_resources(
    connection: &Connection,
    mut stopped: oneshot::Receiver<()>,
    mut interval: watch::Receiver<ResourceInterval>,
    mut emit: impl FnMut(ResourceEvent) -> bool,
) {
    if stopped.try_recv() != Err(oneshot::error::TryRecvError::Empty) {
        return;
    }
    // An open request cannot be recalled. Wait for confirmation so a late
    // channel can be closed without ever sending an exec request.
    let mut channel = match connection.open_session_channel().await {
        Ok(channel) => channel,
        Err(_) => {
            if stopped.try_recv() == Err(oneshot::error::TryRecvError::Empty) {
                emit(ResourceEvent::Unavailable);
            }
            return;
        }
    };
    let result = tokio::select! {
        biased;
        _ = &mut stopped => None,
        result = stream_samples(&mut channel, &mut interval, &mut emit) => Some(result),
    };
    if result == Some(Err(())) {
        emit(ResourceEvent::Unavailable);
    }
    close_sampler(&mut channel).await;
}

async fn stream_samples(
    channel: &mut Session,
    interval: &mut watch::Receiver<ResourceInterval>,
    emit: &mut impl FnMut(ResourceEvent) -> bool,
) -> Result<(), ()> {
    let command = format!(
        "exec /bin/sh -c {} sshastra-resource-sampler",
        shell_quote(SAMPLER)
    );
    timeout(SAMPLE_TIMEOUT, channel.exec(true, command))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
    let mut previous = None;
    let mut buffer = Vec::new();
    loop {
        let started = Instant::now();
        let frame = timeout(SAMPLE_TIMEOUT, next_frame(channel, &mut buffer))
            .await
            .map_err(|_| ())??;
        match frame {
            Frame::Unsupported if previous.is_none() => {
                emit(ResourceEvent::Unsupported);
                return Ok(());
            }
            Frame::Unsupported => return Err(()),
            Frame::Snapshot(sample) => {
                let snapshot = sample.snapshot(previous.as_ref());
                if !emit(ResourceEvent::Snapshot { snapshot }) {
                    return Ok(());
                }
                previous = Some(sample);
            }
        }
        wait_for_sample(started, interval).await;
    }
}

async fn wait_for_sample(started: Instant, interval: &mut watch::Receiver<ResourceInterval>) {
    loop {
        // Pick up either a faster or slower cadence without ever adding a request in flight.
        let deadline = started + interval.borrow_and_update().duration();
        tokio::select! {
            biased;
            change = interval.changed() => {
                if change.is_err() {
                    sleep_until(deadline).await;
                    return;
                }
            }
            () = sleep_until(deadline) => return,
        }
    }
}

async fn next_frame(channel: &mut Session, buffer: &mut Vec<u8>) -> Result<Frame, ()> {
    channel.data(&b"\n"[..]).await.map_err(|_| ())?;
    buffer.clear();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => {
                if data.len() > MAX_FRAME_BYTES - buffer.len() {
                    return Err(());
                }
                buffer.extend_from_slice(&data);
                if buffer.ends_with(b"\nend\n") {
                    return parse_frame(buffer).ok_or(());
                }
            }
            Some(
                ChannelMsg::Failure
                | ChannelMsg::ExtendedData { .. }
                | ChannelMsg::ExitStatus { .. }
                | ChannelMsg::ExitSignal { .. }
                | ChannelMsg::Eof
                | ChannelMsg::Close,
            )
            | None => return Err(()),
            _ => {}
        }
    }
}

async fn close_sampler(channel: &mut Session) {
    let exited = timeout(CLOSE_TIMEOUT, async {
        channel.eof().await?;
        while let Some(message) = channel.wait().await {
            if matches!(
                message,
                ChannelMsg::ExitStatus { .. } | ChannelMsg::ExitSignal { .. } | ChannelMsg::Close
            ) {
                break;
            }
        }
        Ok::<(), russh::Error>(())
    })
    .await;
    if !matches!(exited, Ok(Ok(()))) {
        let _ = timeout(CLOSE_TIMEOUT, channel.signal(Sig::TERM)).await;
    }
    let _ = timeout(CLOSE_TIMEOUT, channel.close()).await;
}

enum Frame {
    Unsupported,
    Snapshot(Sample),
}

struct Sample {
    cpu: [u64; 8],
    cores: u32,
    load: [f64; 3],
    memory: Usage,
    swap: Usage,
    disks: Vec<DiskUsage>,
    network: BTreeMap<String, (u64, u64)>,
    uptime_seconds: f64,
}

impl Sample {
    fn snapshot(&self, previous: Option<&Self>) -> ResourceSnapshot {
        let previous = previous.filter(|sample| sample.uptime_seconds < self.uptime_seconds);
        let cpu_percent = previous.and_then(|prev| cpu_percent(prev.cpu, self.cpu));
        let network = self
            .network
            .iter()
            .map(|(name, &(rx, tx))| {
                let rates = previous.and_then(|prev| {
                    let &(previous_rx, previous_tx) = prev.network.get(name)?;
                    let elapsed = self.uptime_seconds - prev.uptime_seconds;
                    Some((
                        rate(previous_rx, rx, elapsed),
                        rate(previous_tx, tx, elapsed),
                    ))
                });
                let (receive_rate, send_rate) = rates.unwrap_or_default();
                NetworkRate {
                    name: name.clone(),
                    receive_rate,
                    send_rate,
                }
            })
            .collect();
        ResourceSnapshot {
            cpu_percent,
            cores: self.cores,
            load: self.load,
            memory: self.memory,
            swap: self.swap,
            disks: self.disks.clone(),
            network,
            uptime_seconds: self.uptime_seconds,
        }
    }
}

fn cpu_percent(before: [u64; 8], after: [u64; 8]) -> Option<f64> {
    let mut delta = [0; 8];
    for (i, elapsed) in delta.iter_mut().enumerate() {
        *elapsed = u128::from(after[i].checked_sub(before[i])?);
    }
    let total: u128 = delta.iter().sum();
    // /proc/stat counts idle and I/O wait separately, and guest time
    // already appears in user/nice, outside the eight chosen columns.
    let busy = total - delta[3] - delta[4];
    (total > 0).then(|| busy as f64 / total as f64 * 100.0)
}

fn rate(before: u64, after: u64, seconds: f64) -> Option<f64> {
    Some(after.checked_sub(before)? as f64 / seconds)
}

fn parse_frame(frame: &[u8]) -> Option<Frame> {
    if frame.len() > MAX_FRAME_BYTES {
        return None;
    }
    if frame == b"unsupported\nend\n" {
        return Some(Frame::Unsupported);
    }
    let body = str::from_utf8(frame)
        .ok()?
        .strip_prefix("snapshot\n")?
        .strip_suffix("\nend\n")?;
    let (mut cpu, mut cores, mut load, mut memory, mut swap, mut uptime) =
        (None, None, None, None, None, None);
    let mut network = BTreeMap::new();
    let mut disks = Vec::new();
    let mut mount_points = HashSet::new();
    for line in body.lines() {
        let (kind, fields) = line.split_once(' ')?;
        match kind {
            "cpu" if cpu.is_none() => cpu = Some(numbers(fields)?),
            "cores" if cores.is_none() => {
                let [count] = numbers::<u32, 1>(fields)?;
                if count == 0 {
                    return None;
                }
                cores = Some(count);
            }
            "load" if load.is_none() => {
                let values = numbers(fields)?;
                if !values.iter().copied().all(valid_decimal) {
                    return None;
                }
                load = Some(values);
            }
            "memory" if memory.is_none() => memory = Some(memory_usage(fields)?),
            "swap" if swap.is_none() => swap = Some(memory_usage(fields)?),
            "uptime" if uptime.is_none() => {
                let [seconds] = numbers(fields)?;
                if !valid_decimal(seconds) {
                    return None;
                }
                uptime = Some(seconds);
            }
            "net" => {
                let (name, counters) = fields.split_once(' ')?;
                if !valid_label(name, 15) {
                    return None;
                }
                let [rx, tx] = numbers(counters)?;
                if name != "lo"
                    && (network.len() >= MAX_INTERFACES
                        || network.insert(name.to_owned(), (rx, tx)).is_some())
                {
                    return None;
                }
            }
            "disk" if disks.len() < MAX_MOUNTS => {
                let mut fields = fields.splitn(3, ' ');
                let total = fields.next()?.parse().ok()?;
                let used = fields.next()?.parse().ok()?;
                let mount = fields.next()?;
                if !mount.starts_with('/')
                    || !valid_label(mount, 4096)
                    || !mount_points.insert(mount)
                {
                    return None;
                }
                disks.push(DiskUsage {
                    mount: mount.into(),
                    usage: use_kib(used, total)?,
                });
            }
            _ => return None,
        }
    }
    Some(Frame::Snapshot(Sample {
        cpu: cpu?,
        cores: cores?,
        load: load?,
        memory: memory?,
        swap: swap?,
        disks,
        network,
        uptime_seconds: uptime?,
    }))
}

fn numbers<T: str::FromStr + Default + Copy, const N: usize>(fields: &str) -> Option<[T; N]> {
    let mut fields = fields.split_ascii_whitespace();
    let mut values = [T::default(); N];
    for value in &mut values {
        *value = fields.next()?.parse().ok()?;
    }
    fields.next().is_none().then_some(values)
}

fn valid_decimal(value: f64) -> bool {
    (0.0..=1e12).contains(&value)
}

fn valid_label(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

fn memory_usage(fields: &str) -> Option<Usage> {
    let [total, free] = numbers::<u64, 2>(fields)?;
    use_kib(total.checked_sub(free)?, total)
}

fn use_kib(used: u64, total: u64) -> Option<Usage> {
    if used > total {
        return None;
    }
    Some(Usage {
        used: used.checked_mul(1024)?,
        total: total.checked_mul(1024)?,
    })
}

#[cfg(test)]
mod tests;
