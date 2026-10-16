//! Authoritative, fixed-step multiplayer simulation. This module deliberately
//! accepts intent only: clients never submit positions, hit claims, or health.
use crate::hitboxes::{HitPart, ray_hit_volumes, sample_hit_volumes};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::f64::consts::{LN_10, PI, SQRT_2};

pub const MAX_PLAYERS: usize = 6;
pub const DEFAULT_PLAYER_NAME: &str = "Unknown Soldier";
pub const TICK_SECONDS: f64 = 1.0 / 60.0;
pub const ROUND_SECONDS: f64 = 300.0;
pub const INPUT_TIMEOUT: f64 = 0.25;
/// Scheduled commands may lead the authority by at most half a second. The
/// queue has at most one command per tick; packet count never advances time.
pub const MAX_INPUT_LEAD_TICKS: u64 = 30;
pub const MAX_REWIND: f64 = 0.2;
const UNSET: f64 = -1000.0;
const RADIUS: f64 = 0.3;
const GRAVITY: f64 = 22.0;
const JUMP_SPEED: f64 = 7.3;
const SWITCH_SECONDS: f64 = 0.6;
const MELEE_SECONDS: f64 = 0.85 / 1.2;
const LEAN_DISTANCE: f64 = 0.32 * 1.3;
const LEAN_CAMERA_RADIUS: f64 = 0.16;
const LEAN_SKIN: f64 = 0.001;
const SKIN: f64 = 0.00001;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Faction {
    #[default]
    British,
    Russian,
    German,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Stance {
    #[default]
    Stand,
    Crouch,
    Prone,
}

impl Stance {
    fn height(self) -> f64 {
        match self {
            Self::Stand => 1.65,
            Self::Crouch => 1.05,
            Self::Prone => 0.43,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WeaponSlot {
    #[default]
    Rifle,
    Grenade,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InputFrame {
    pub seq: u64,
    pub tick: Option<u64>,
    pub generation: Option<u64>,
    pub forward: f64,
    pub right: f64,
    pub yaw: f64,
    pub pitch: f64,
    pub jump: bool,
    pub walk: bool,
    pub lean: f64,
    pub ads: bool,
    pub stance: Option<Stance>,
    pub weapon: Option<WeaponSlot>,
    pub fire: bool,
    pub reload: bool,
    pub melee: bool,
    pub shot_time: Option<f64>,
}

/// Gait is simulation state, shared by rendering, hits and historical rewind.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionPose {
    pub phase: f64,
    pub crouch: f64,
    pub prone: f64,
    pub aim: f64,
    pub speed: f64,
    pub forward: f64,
    pub sideways: f64,
}
impl MotionPose {
    fn initial(a: &Actor) -> Self {
        Self {
            phase: f64::from(a.id) * 0.19,
            crouch: if a.stance == Stance::Crouch { 1.0 } else { 0.0 },
            prone: if a.stance == Stance::Prone { 1.0 } else { 0.0 },
            aim: if a.ads { 1.0 } else { 0.0 },
            speed: a.moving,
            forward: 1.0,
            sideways: 0.0,
        }
    }
    fn interpolate(a: Self, b: Self, t: f64) -> Self {
        Self {
            phase: lerp(a.phase, b.phase, t),
            crouch: lerp(a.crouch, b.crouch, t),
            prone: lerp(a.prone, b.prone, t),
            aim: lerp(a.aim, b.aim, t),
            speed: lerp(a.speed, b.speed, t),
            forward: lerp(a.forward, b.forward, t),
            sideways: lerp(a.sideways, b.sideways, t),
        }
    }
}
fn gait_rate(speed: f64, crouch: f64, prone: f64) -> f64 {
    let v = ((speed - 1.8) / 3.0).clamp(0.0, 1.0);
    let stride = lerp(lerp(1.65, 2.95, v * v * (3.0 - 2.0 * v)), 1.80, crouch);
    lerp(lerp(1.75, 1.60, crouch), 1.20, prone).min(speed.max(0.0) / lerp(stride, 1.10, prone))
}
fn advance_motion(a: &mut Actor, dt: f64, old_x: f64, old_z: f64) {
    let mut s = a.pose.unwrap_or_else(|| MotionPose::initial(a));
    let speed = if a.alive { a.moving } else { 0.0 };
    let crouch = if a.stance == Stance::Crouch { 1.0 } else { 0.0 };
    let prone = if a.stance == Stance::Prone { 1.0 } else { 0.0 };
    let weight = 1.0 - (-dt * 12.0).exp();
    let steps = (dt / 0.02).ceil().max(1.0) as usize;
    let step = dt / steps as f64;
    let offset = (3.0_f64 / 5.0).sqrt() * step * 0.5;
    let rate_at = |t: f64| {
        gait_rate(
            lerp(speed, s.speed, (-t * 9.0).exp()),
            lerp(crouch, s.crouch, (-t * 12.0).exp()),
            lerp(prone, s.prone, (-t * 12.0).exp()),
        )
    };
    let mut phase = s.phase;
    for i in 0..steps {
        let middle = (i as f64 + 0.5) * step;
        phase += step
            * (5.0 * rate_at(middle - offset)
                + 8.0 * rate_at(middle)
                + 5.0 * rate_at(middle + offset))
            / 18.0;
    }
    s.phase = phase;
    s.crouch = lerp(s.crouch, crouch, weight);
    s.prone = lerp(s.prone, prone, weight);
    s.aim = lerp(s.aim, if a.ads { 1.0 } else { 0.0 }, weight);
    s.speed = lerp(s.speed, speed, 1.0 - (-dt * 9.0).exp());
    let dx = a.x - old_x;
    let dz = a.z - old_z;
    let distance = dx.hypot(dz);
    if distance > 0.0001 && dt > 0.0 {
        s.forward = lerp(
            s.forward,
            (dx * a.yaw.sin() + dz * a.yaw.cos()) / distance,
            weight,
        );
        s.sideways = lerp(
            s.sideways,
            (dx * a.yaw.cos() - dz * a.yaw.sin()) / distance,
            weight,
        );
    }
    a.pose = Some(s);
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub id: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pose: Option<MotionPose>,
    pub name: String,
    pub faction: Faction,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub yaw: f64,
    pub pitch: f64,
    pub stance: Stance,
    pub eye_height: f64,
    pub hp: u32,
    pub ammo: u32,
    pub reserve: u32,
    pub kills: i32,
    pub deaths: u32,
    pub shots: u32,
    pub hits: u32,
    pub alive: bool,
    pub spectator: bool,
    pub cooldown: f64,
    pub reload: f64,
    pub reload_total: f64,
    pub vy: f64,
    pub grounded: bool,
    pub left_ground_at: f64,
    pub jump_started: f64,
    pub landed_at: f64,
    pub landing_speed: f64,
    pub moving: f64,
    pub ads: bool,
    pub lean: f64,
    pub recoil: f64,
    pub spawn_safe: f64,
    pub dead_at: f64,
    pub last_shot_time: f64,
    pub last_hurt_time: f64,
    pub last_melee_time: f64,
    pub selected_weapon: WeaponSlot,
    pub switch_from: WeaponSlot,
    pub switch_started: f64,
    pub switch_duration: f64,
    pub death_yaw: f64,
    pub death_headshot: bool,
    pub hip_spread: f64,
    pub ack: u64,
    #[serde(default)]
    pub(crate) spawn_generation: u64,
}

impl Actor {
    fn new(id: u32, name: String, faction: Faction) -> Self {
        Self {
            id,
            pose: Some(MotionPose {
                phase: f64::from(id) * 0.19,
                crouch: 0.0,
                prone: 0.0,
                aim: 0.0,
                speed: 0.0,
                forward: 1.0,
                sideways: 0.0,
            }),
            name,
            faction,
            x: 0.0,
            y: 0.0,
            z: 0.0,
            yaw: 0.0,
            pitch: 0.0,
            stance: Stance::Stand,
            eye_height: 1.65,
            hp: 100,
            ammo: weapon(faction).capacity,
            reserve: 150 - weapon(faction).capacity,
            kills: 0,
            deaths: 0,
            shots: 0,
            hits: 0,
            alive: true,
            spectator: false,
            cooldown: 0.45,
            reload: 0.0,
            reload_total: 0.0,
            vy: 0.0,
            grounded: true,
            left_ground_at: UNSET,
            jump_started: UNSET,
            landed_at: UNSET,
            landing_speed: 0.0,
            moving: 0.0,
            ads: false,
            lean: 0.0,
            recoil: 0.0,
            spawn_safe: 1.5,
            dead_at: UNSET,
            last_shot_time: UNSET,
            last_hurt_time: UNSET,
            last_melee_time: UNSET,
            selected_weapon: WeaponSlot::Rifle,
            switch_from: WeaponSlot::Rifle,
            switch_started: UNSET,
            switch_duration: SWITCH_SECONDS,
            death_yaw: 0.0,
            death_headshot: false,
            hip_spread: player_spread(Stance::Stand, 0.0),
            ack: 0,
            spawn_generation: 0,
        }
    }

    pub fn eye(&self) -> Vec3 {
        Vec3 {
            x: self.x - self.yaw.cos() * self.lean * LEAN_DISTANCE,
            y: self.y + self.eye_height,
            z: self.z + self.yaw.sin() * self.lean * LEAN_DISTANCE,
        }
    }

    fn switching(&self, now: f64) -> bool {
        now - self.switch_started < self.switch_duration
    }

    fn can_ads(&self, now: f64) -> bool {
        self.alive
            && !self.spectator
            && self.grounded
            && self.selected_weapon == WeaponSlot::Rifle
            && self.reload <= 0.0
            && !self.switching(now)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Shot {
    pub time: f64,
    pub actor: u32,
    pub origin: Vec3,
    pub end: Vec3,
    pub hit: Option<u32>,
    pub headshot: bool,
    pub kind: String,
    pub seq: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GameEvent {
    #[serde(rename = "type")]
    pub kind: String,
    pub actor: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub victim: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shot: Option<Shot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headshot: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weapon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

impl GameEvent {
    fn new(kind: &str, actor: u32, seq: Option<u64>) -> Self {
        Self {
            kind: kind.into(),
            actor,
            seq,
            victim: None,
            shot: None,
            headshot: None,
            value: None,
            weapon: None,
        }
    }
}

#[derive(Clone, Copy)]
struct Weapon {
    capacity: u32,
    cycle: f64,
    reload: f64,
    recoil: f64,
}
fn weapon(faction: Faction) -> Weapon {
    match faction {
        Faction::British => Weapon {
            capacity: 10,
            cycle: 1.08,
            reload: 3.25,
            recoil: 0.07938,
        },
        Faction::Russian => Weapon {
            capacity: 5,
            cycle: 1.18,
            reload: 2.6,
            recoil: 0.08883,
        },
        Faction::German => Weapon {
            capacity: 5,
            cycle: 1.12,
            reload: 2.55,
            recoil: 0.08316,
        },
    }
}

#[derive(Clone, Copy, Debug)]
struct WorldBox {
    x: f64,
    z: f64,
    w: f64,
    d: f64,
    h: f64,
}
fn map_boxes() -> Vec<WorldBox> {
    let scale = 1.0 / SQRT_2;
    let dimensions = [
        [-15.0, -17.0, 5.0, 5.0, 3.5],
        [-7.0, -18.0, 4.0, 4.0, 1.2],
        [3.0, -18.0, 5.0, 5.0, 2.3],
        [14.0, -18.0, 5.0, 5.0, 3.8],
        [-16.0, -8.0, 4.0, 4.0, 1.5],
        [-7.0, -9.0, 5.0, 5.0, 3.6],
        [4.0, -8.0, 4.0, 4.0, 1.1],
        [14.0, -8.0, 5.0, 5.0, 2.7],
        [-16.0, 2.0, 5.0, 5.0, 3.5],
        [-6.0, 1.0, 4.0, 4.0, 1.7],
        [5.0, 2.0, 5.0, 5.0, 3.4],
        [15.0, 3.0, 4.0, 4.0, 1.1],
        [-15.0, 13.0, 5.0, 5.0, 2.3],
        [-6.0, 12.0, 4.0, 4.0, 1.1],
        [4.0, 13.0, 5.0, 5.0, 2.6],
        [14.0, 14.0, 5.0, 5.0, 3.6],
        [-5.0, 20.0, 3.0, 3.0, 2.4],
        [7.0, 21.0, 3.0, 3.0, 1.1],
    ];
    let mut result: Vec<_> = dimensions
        .iter()
        .map(|b| WorldBox {
            x: b[0] * scale,
            z: b[1] * scale,
            w: b[2] * scale,
            d: b[3] * scale,
            h: b[4],
        })
        .collect();
    let width = 42.0 * scale;
    let depth = 48.0 * scale;
    result.extend([
        WorldBox {
            x: -width / 2.0 - 0.5,
            z: 0.0,
            w: 1.0,
            d: depth + 2.0,
            h: 7.0,
        },
        WorldBox {
            x: width / 2.0 + 0.5,
            z: 0.0,
            w: 1.0,
            d: depth + 2.0,
            h: 7.0,
        },
        WorldBox {
            x: 0.0,
            z: -depth / 2.0 - 0.5,
            w: width,
            d: 1.0,
            h: 7.0,
        },
        WorldBox {
            x: 0.0,
            z: depth / 2.0 + 0.5,
            w: width,
            d: 1.0,
            h: 7.0,
        },
    ]);
    result
}

fn spawn_points() -> Vec<(f64, f64)> {
    [
        (-19.0, 21.0),
        (19.0, -21.0),
        (-19.0, -21.0),
        (19.0, 21.0),
        (0.0, -22.0),
        (0.0, 21.0),
        (-19.0, 8.0),
        (19.0, -1.0),
    ]
    .into_iter()
    .map(|(x, z)| (x / SQRT_2, z / SQRT_2))
    .collect()
}

#[derive(Clone, Debug)]
struct PendingAttack {
    seq: u64,
    yaw: f64,
    pitch: f64,
    shot_time: Option<f64>,
}

/// Connection-local scheduling observations. These are derived from the
/// authority's tick clock, never client-supplied ping or timing claims.
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputTiming {
    pub received: u64,
    pub late: u64,
    pub missing: u64,
    pub arrival_lead: i32,
    pub shots: u64,
    pub rewind_clamped: u64,
    pub shot_age_ms: f64,
}

#[derive(Default)]
struct Control {
    latest: InputFrame,
    scheduled: bool,
    queue: BTreeMap<u64, InputFrame>,
    received_seq: u64,
    received_tick: u64,
    received: f64,
    seen_input: bool,
    jump: bool,
    reload: Option<u64>,
    fire: Option<PendingAttack>,
    melee: Option<PendingAttack>,
    step_clock: f64,
    timing: InputTiming,
    observed_seq: u64,
    first_scheduled_tick: Option<u64>,
}

#[derive(Clone)]
struct HistoryFrame {
    time: f64,
    actors: Vec<Actor>,
}

pub struct Simulation {
    pub actors: Vec<Actor>,
    pub time: f64,
    pub remaining: f64,
    pub ended: bool,
    pub winner: Option<u32>,
    pub round_number: u64,
    pub tick_number: u64,
    pub ended_at: Option<f64>,
    round_started: f64,
    seed: u32,
    controls: BTreeMap<u32, Control>,
    events: Vec<GameEvent>,
    history: VecDeque<HistoryFrame>,
    boxes: Vec<WorldBox>,
}

impl Simulation {
    pub fn new(seed: u32) -> Self {
        Self {
            actors: Vec::new(),
            time: 0.0,
            remaining: ROUND_SECONDS,
            ended: false,
            winner: None,
            round_number: 1,
            tick_number: 0,
            ended_at: None,
            round_started: 0.0,
            seed,
            controls: BTreeMap::new(),
            events: Vec::new(),
            history: VecDeque::new(),
            boxes: map_boxes(),
        }
    }

    fn random(&mut self) -> f64 {
        self.seed = self.seed.wrapping_mul(1664525).wrapping_add(1013904223);
        f64::from(self.seed) / 4294967296.0
    }

    pub fn actor(&self, id: u32) -> Option<&Actor> {
        self.actors.iter().find(|a| a.id == id)
    }
    pub fn actor_mut(&mut self, id: u32) -> Option<&mut Actor> {
        self.actors.iter_mut().find(|a| a.id == id)
    }

    /// Perception uses the same occluding geometry as authoritative bullets.
    pub(crate) fn line_of_sight(&self, from: Vec3, to: Vec3) -> bool {
        visible(&self.boxes, from, to)
    }

    /// Navigation stays on the arena floor and pads obstacles by the player's
    /// collision radius. AI never teleports or edits an actor's position.
    pub(crate) fn walkable(&self, x: f64, z: f64) -> bool {
        let margin = RADIUS + 0.12;
        x.abs() < 21.0 / SQRT_2 - margin
            && z.abs() < 24.0 / SQRT_2 - margin
            && !self.boxes.iter().any(|b| {
                (x - b.x).abs() < b.w / 2.0 + margin
                    && (z - b.z).abs() < b.d / 2.0 + margin
            })
    }

    pub(crate) fn walkable_segment(&self, from: Vec3, to: Vec3) -> bool {
        let steps = ((to.x - from.x).hypot(to.z - from.z) / 0.2).ceil().max(1.0) as usize;
        (0..=steps).all(|i| {
            let t = i as f64 / steps as f64;
            self.walkable(lerp(from.x, to.x, t), lerp(from.z, to.z, t))
        })
    }

    pub fn join(&mut self, id: u32, name: String, faction: Faction) -> Result<(), &'static str> {
        self.join_participant(id, name, faction, false)
    }

    pub fn join_participant(
        &mut self,
        id: u32,
        name: String,
        faction: Faction,
        spectator: bool,
    ) -> Result<(), &'static str> {
        if self.actor(id).is_some() {
            return Err("Actor already joined");
        }
        if self.actors.len() >= MAX_PLAYERS {
            return Err("Lobby is full");
        }
        self.actors
            .push(Actor::new(id, sanitize_name(&name), faction));
        self.actors.sort_by_key(|a| a.id);
        self.controls.insert(id, Control::default());
        if spectator {
            self.spectate(id);
        } else {
            self.spawn(id);
        }
        self.record();
        Ok(())
    }

    pub fn leave(&mut self, id: u32) -> bool {
        let before = self.actors.len();
        self.actors.retain(|a| a.id != id);
        self.controls.remove(&id);
        before != self.actors.len()
    }

    /// Suspend intent immediately on disconnect; the lobby layer owns the grace
    /// period. Sequence state remains intact for a reconnect to the same actor.
    pub fn neutralize(&mut self, id: u32) {
        if let Some(c) = self.controls.get_mut(&id) {
            c.queue.clear();
            c.received_tick = self.tick_number;
            c.latest.forward = 0.0;
            c.latest.right = 0.0;
            c.latest.lean = 0.0;
            c.latest.ads = false;
            c.jump = false;
            c.reload = None;
            c.fire = None;
            c.melee = None;
            c.timing = InputTiming::default();
            c.observed_seq = c.received_seq;
            c.first_scheduled_tick = None;
        }
    }

    /// A replacement connection starts from the acknowledged sequence, not an
    /// input that was queued by the previous socket and never simulated.
    pub fn reset_input_stream(&mut self, id: u32) {
        self.neutralize(id);
        let ack = self.actor(id).map_or(0, |a| a.ack);
        if let Some(c) = self.controls.get_mut(&id) {
            c.scheduled = false;
            c.latest.seq = ack;
            c.received_seq = ack;
            c.received_tick = 0;
            c.observed_seq = ack;
        }
    }

    pub fn input_timing(&self, id: u32) -> InputTiming {
        self.controls.get(&id).map_or_else(InputTiming::default, |c| c.timing)
    }

    pub fn change_faction(&mut self, id: u32, faction: Faction) -> bool {
        if self.ended {
            return false;
        }
        let now = self.time;
        let Some(actor) = self.actor_mut(id) else {
            return false;
        };
        if actor.spectator {
            actor.spectator = false;
            actor.faction = faction;
            self.spawn(id);
            return true;
        }
        if actor.faction == faction {
            return false;
        }
        actor.faction = faction;
        // Changing loadout costs a death during live play; it cannot provide a
        // free heal/ammo reset or preserve a perfect score under fire.
        if !actor.alive {
            return true;
        }
        actor.deaths += 1;
        actor.alive = false;
        actor.hp = 0;
        actor.dead_at = now;
        actor.moving = 0.0;
        actor.ads = false;
        actor.reload = 0.0;
        actor.cooldown = 0.0;
        let mut event = GameEvent::new("kill", id, None);
        event.victim = Some(id);
        event.headshot = Some(false);
        event.weapon = Some("rifle".into());
        actor.kills -= 1;
        self.events.push(event);
        self.neutralize(id);
        true
    }

    /// Observation is a participation mode, never a death or a damageable body.
    /// Camera movement stays local; stale combat input cannot survive a change.
    pub fn spectate(&mut self, id: u32) -> bool {
        let Some(actor) = self.actor_mut(id) else {
            return false;
        };
        if actor.spectator {
            return false;
        }
        actor.spectator = true;
        actor.alive = false;
        actor.hp = 0;
        actor.moving = 0.0;
        if let Some(pose) = actor.pose.as_mut() {
            pose.speed = 0.0;
            pose.aim = 0.0;
        }
        actor.vy = 0.0;
        actor.ads = false;
        actor.lean = 0.0;
        actor.recoil = 0.0;
        actor.cooldown = 0.0;
        actor.reload = 0.0;
        actor.reload_total = 0.0;
        actor.spawn_safe = 0.0;
        actor.last_melee_time = UNSET;
        actor.last_shot_time = UNSET;
        actor.last_hurt_time = UNSET;
        actor.switch_started = UNSET;
        actor.dead_at = UNSET;
        actor.spawn_generation += 1;
        self.neutralize(id);
        true
    }

    /// Reject non-finite, replayed and out-of-range packets before they can
    /// contaminate the physics. Packet rate limiting is also applied by the socket.
    pub fn submit_input(&mut self, id: u32, mut input: InputFrame) -> bool {
        if input.seq > 9_007_199_254_740_991
            || ![
                input.forward,
                input.right,
                input.lean,
                input.yaw,
                input.pitch,
            ]
            .iter()
            .all(|v| v.is_finite())
            || input.shot_time.is_some_and(|v| !v.is_finite())
            || input.yaw.abs() > 1_000_000.0
            || input.pitch.abs() > 100.0
        {
            return false;
        }
        if let Some(tick) = input.tick {
            if self.ended
                || tick > self.tick_number.saturating_add(MAX_INPUT_LEAD_TICKS)
                || self.actor(id).is_none_or(|a| input.generation != Some(a.spawn_generation))
            {
                return false;
            }
        }
        let Some(control) = self.controls.get_mut(&id) else {
            return false;
        };
        if let Some(tick) = input.tick {
            if input.seq > control.observed_seq {
                control.observed_seq = input.seq;
                control.timing.received = control.timing.received.saturating_add(1);
                control.timing.arrival_lead = (i128::from(tick) - i128::from(self.tick_number))
                    .clamp(i128::from(i32::MIN), i128::from(i32::MAX)) as i32;
                if tick <= self.tick_number {
                    control.timing.late = control.timing.late.saturating_add(1);
                }
            }
            if tick <= self.tick_number {
                return false;
            }
        }
        if control.seen_input && input.seq <= control.received_seq {
            return false;
        }
        input.forward = input.forward.clamp(-1.0, 1.0);
        input.right = input.right.clamp(-1.0, 1.0);
        input.lean = input.lean.clamp(-1.0, 1.0);
        input.yaw = (input.yaw + PI).rem_euclid(2.0 * PI) - PI;
        input.pitch = input.pitch.clamp(-1.45, 1.45);
        if let Some(tick) = input.tick {
            if tick <= control.received_tick {
                return false;
            }
            // Transitioning from a legacy stream must not carry latched actions
            // into a scheduled tick. Each pulse belongs to exactly one command.
            control.scheduled = true;
            control.jump = false;
            control.reload = None;
            control.fire = None;
            control.melee = None;
            control.received_seq = input.seq;
            control.received_tick = tick;
            control.received = self.time;
            control.seen_input = true;
            control.first_scheduled_tick.get_or_insert(tick);
            control.queue.insert(tick, input);
            return true;
        }
        if control.scheduled {
            return false;
        }
        let attack = PendingAttack {
            seq: input.seq,
            yaw: input.yaw,
            pitch: input.pitch,
            shot_time: input.shot_time,
        };
        // Only one pending action can exist per tick, regardless of packet spam.
        if input.fire && control.fire.is_none() {
            control.fire = Some(attack.clone());
        }
        if input.melee && control.melee.is_none() {
            control.melee = Some(attack);
        }
        if input.reload {
            control.reload = Some(input.seq);
        }
        control.jump |= input.jump;
        control.received_seq = input.seq;
        control.latest = input;
        control.received = self.time;
        control.seen_input = true;
        true
    }

    pub fn drain_events(&mut self) -> Vec<GameEvent> {
        std::mem::take(&mut self.events)
    }

    fn spawn(&mut self, id: u32) {
        if self.actor(id).is_none_or(|a| a.spectator) {
            return;
        }
        let mut best = spawn_points()[0];
        let mut best_score = f64::NEG_INFINITY;
        for (x, z) in spawn_points() {
            let mut nearest: f64 = 100.0;
            let mut sight = 0;
            for other in &self.actors {
                if other.id == id || !other.alive || other.spectator {
                    continue;
                }
                nearest = nearest.min((other.x - x).hypot(other.z - z));
                if visible(&self.boxes, Vec3 { x, y: 1.65, z }, other.eye()) {
                    sight += 1;
                }
            }
            if nearest < RADIUS * 2.0 + 0.02 {
                continue;
            }
            let score = nearest - f64::from(sight) * 9.0 + self.random() * 4.0;
            if score > best_score {
                best_score = score;
                best = (x, z);
            }
        }
        if let Some(a) = self.actor_mut(id) {
            let previous = a.clone();
            *a = Actor::new(id, previous.name, previous.faction);
            a.kills = previous.kills;
            a.deaths = previous.deaths;
            a.shots = previous.shots;
            a.hits = previous.hits;
            a.ack = previous.ack;
            a.spawn_generation = previous.spawn_generation + 1;
            a.x = best.0;
            a.z = best.1;
            a.yaw = (-a.x).atan2(-a.z);
        }
        self.neutralize(id);
        if let Some(control) = self.controls.get_mut(&id) {
            control.latest.stance = Some(Stance::Stand);
            control.latest.weapon = Some(WeaponSlot::Rifle);
            if let Some(a) = self.actors.iter().find(|a| a.id == id) {
                control.latest.yaw = a.yaw;
                control.latest.pitch = a.pitch;
            }
        }
        self.events.push(GameEvent::new("spawn", id, None));
    }

    pub fn restart_round(&mut self) {
        self.round_number += 1;
        self.round_started = self.time;
        self.remaining = ROUND_SECONDS;
        self.ended = false;
        self.ended_at = None;
        self.winner = None;
        self.history.clear();
        let ids: Vec<_> = self.actors.iter().map(|a| a.id).collect();
        for a in &mut self.actors {
            a.kills = 0;
            a.deaths = 0;
            a.shots = 0;
            a.hits = 0;
            a.alive = false;
        }
        for id in ids {
            self.spawn(id);
        }
        self.record();
    }

    fn finish(&mut self) {
        if self.ended {
            return;
        }
        self.ended = true;
        self.ended_at = Some(self.time);
        self.winner = self
            .actors
            .iter()
            .filter(|a| !a.spectator)
            .max_by(|a, b| {
                a.kills
                    .cmp(&b.kills)
                    .then_with(|| b.deaths.cmp(&a.deaths))
                    .then_with(|| b.id.cmp(&a.id))
            })
            .map(|a| a.id);
        for a in &mut self.actors {
            if let Some(pose) = a.pose.as_mut() {
                pose.speed = 0.0;
                pose.aim = 0.0;
            }
            a.moving = 0.0;
            a.vy = 0.0;
            a.grounded = true;
            a.left_ground_at = UNSET;
            a.jump_started = UNSET;
            a.landed_at = UNSET;
            a.landing_speed = 0.0;
            a.ads = false;
            a.lean = 0.0;
            a.recoil = 0.0;
            a.cooldown = 0.0;
            a.reload = 0.0;
            a.reload_total = 0.0;
            a.last_shot_time = UNSET;
            a.last_melee_time = UNSET;
            a.last_hurt_time = UNSET;
            a.switch_from = a.selected_weapon;
            a.switch_started = UNSET;
        }
        for c in self.controls.values_mut() {
            c.jump = false;
            c.reload = None;
            c.fire = None;
            c.melee = None;
            c.step_clock = 0.0;
        }
        if let Some(winner) = self.winner {
            self.events.push(GameEvent::new("end", winner, None));
        }
    }

    /// The caller supplies fixed 60 Hz steps. A delayed task never accepts a
    /// client-provided delta or a giant elapsed-time movement step.
    pub fn tick(&mut self, dt: f64) {
        if !dt.is_finite() || dt <= 0.0 {
            return;
        }
        let dt = dt.min(0.05);
        self.time += dt;
        self.tick_number += 1;
        if self.ended {
            for control in self.controls.values_mut() {
                control.queue.clear();
            }
            return;
        }
        self.remaining = (ROUND_SECONDS - (self.time - self.round_started)).max(0.0);
        if self.remaining <= 1e-8 {
            self.remaining = 0.0;
            self.finish();
            return;
        }

        let ids: Vec<_> = self.actors.iter().map(|a| a.id).collect();
        for &id in &ids {
            let index = self.actors.iter().position(|a| a.id == id).unwrap();
            if self.actors[index].spectator {
                continue;
            }
            if !self.actors[index].alive {
                if self.time - self.actors[index].dead_at >= 3.0 {
                    self.spawn(id);
                }
                continue;
            }
            let a = &mut self.actors[index];
            let old = a.cooldown;
            a.cooldown = (a.cooldown - dt).max(0.0);
            a.spawn_safe = (a.spawn_safe - dt).max(0.0);
            a.recoil *= (-dt * 4.2).exp();
            if a.selected_weapon == WeaponSlot::Rifle && old > 0.65 && a.cooldown <= 0.65 {
                self.events.push(GameEvent::new("bolt", id, None));
            }
            if a.reload > 0.0 {
                a.reload = (a.reload - dt).max(0.0);
                if a.reload == 0.0 {
                    let rounds = (weapon(a.faction).capacity - a.ammo).min(a.reserve);
                    a.ammo += rounds;
                    a.reserve -= rounds;
                }
            }
        }
        // Movement for all players precedes attacks, so packet arrival ordering
        // cannot give one player a whole simulation tick of movement advantage.
        let mut actions = Vec::new();
        for &id in &ids {
            let Some(control) = self.controls.get_mut(&id) else {
                continue;
            };
            let fresh = if control.scheduled {
                // Missing ticks use neutral movement (gravity/timers still
                // run). Late commands are rejected, never applied to a second
                // tick. The snapshot tick acknowledges these neutral gaps too.
                if let Some(input) = control.queue.remove(&self.tick_number) {
                    let attack = PendingAttack {
                        seq: input.seq,
                        yaw: input.yaw,
                        pitch: input.pitch,
                        shot_time: input.shot_time,
                    };
                    control.jump = input.jump;
                    control.reload = input.reload.then_some(input.seq);
                    control.fire = input.fire.then_some(attack.clone());
                    control.melee = input.melee.then_some(attack);
                    control.latest = input;
                    true
                } else {
                    if control.first_scheduled_tick.is_some_and(|tick| self.tick_number >= tick)
                        && self.actors.iter().any(|a| a.id == id && a.alive && !a.spectator)
                    {
                        control.timing.missing = control.timing.missing.saturating_add(1);
                    }
                    false
                }
            } else {
                control.seen_input && self.time - control.received <= INPUT_TIMEOUT
            };
            let mut input = control.latest.clone();
            if !fresh {
                input.forward = 0.0;
                input.right = 0.0;
                input.lean = 0.0;
                input.ads = false;
            }
            let jump = std::mem::take(&mut control.jump) && fresh;
            let reload = control.reload.take().filter(|_| fresh);
            let fire = control.fire.take().filter(|_| fresh);
            let melee = control.melee.take().filter(|_| fresh);
            let index = self.actors.iter().position(|a| a.id == id).unwrap();
            self.actors[index].ack = input.seq;
            if !self.actors[index].alive || self.actors[index].spectator {
                continue;
            }
            if fresh {
                self.actors[index].yaw = input.yaw;
                self.actors[index].pitch = input.pitch;
                if let Some(stance) = input.stance {
                    self.actors[index].stance = stance;
                }
                if let Some(slot) = input.weapon {
                    self.select_weapon(index, slot, Some(input.seq));
                }
            }
            // Reload drops ADS before movement, matching first-person prediction
            // and avoiding a one-tick speed correction when the key is pressed.
            // Defer its event until the attack is resolved: an eligible melee
            // in this input cancels the reload without a false reload cue.
            let started_reload = reload.filter(|_| self.begin_reload(index));
            self.actors[index].ads = input.ads && self.actors[index].can_ads(self.time);
            self.move_actor(index, &input, jump, dt);
            let a = &mut self.actors[index];
            let target = player_spread(a.stance, a.moving);
            let duration = if target > a.hip_spread { 0.075 } else { 0.45 };
            a.hip_spread = target + (a.hip_spread - target) * (-LN_10 * dt / duration).exp();
            let next = a.lean + (input.lean - a.lean) * (1.0 - (-12.0 * dt).exp());
            a.lean = constrain_lean(a, next, &self.boxes);
            if a.moving > 0.2 && a.grounded {
                let control = self.controls.get_mut(&id).unwrap();
                control.step_clock += dt * if a.stance == Stance::Stand { 1.0 } else { 0.65 };
                if control.step_clock > 0.37 {
                    control.step_clock = 0.0;
                    let mut event = GameEvent::new("step", id, None);
                    event.value = Some(a.moving);
                    self.events.push(event);
                }
            }
            actions.push((index, fire, melee, started_reload));
        }
        self.record();
        for (index, fire, melee, started_reload) in actions {
            if let Some(attack) = melee {
                self.fire(index, true, &attack);
            } else if let Some(attack) = fire {
                self.fire(index, false, &attack);
            }
            if self.actors[index].reload > 0.0
                && let Some(seq) = started_reload
            {
                self.events
                    .push(GameEvent::new("reload", self.actors[index].id, Some(seq)));
            }
            if self.actors[index].ammo == 0
                && self.actors[index].cooldown == 0.0
                && self.actors[index].reload == 0.0
            {
                self.reload(index, None);
            }
        }
        // Replace this tick's pre-attack frame with the state sent in snapshots.
        // Recoil and manipulation timestamps also move damageable arm bones.
        self.record();
    }

    fn select_weapon(&mut self, index: usize, slot: WeaponSlot, seq: Option<u64>) {
        let a = &mut self.actors[index];
        if !a.alive || a.spectator || a.selected_weapon == slot || a.switching(self.time) {
            return;
        }
        a.switch_from = a.selected_weapon;
        a.selected_weapon = slot;
        a.switch_started = self.time;
        a.switch_duration = SWITCH_SECONDS;
        a.ads = false;
        a.reload = 0.0;
        a.reload_total = 0.0;
        let mut event = GameEvent::new("switch", a.id, seq);
        event.weapon = Some(
            match slot {
                WeaponSlot::Rifle => "rifle",
                WeaponSlot::Grenade => "grenade",
            }
            .into(),
        );
        self.events.push(event);
    }

    fn reload(&mut self, index: usize, seq: Option<u64>) {
        if self.begin_reload(index) {
            self.events
                .push(GameEvent::new("reload", self.actors[index].id, seq));
        }
    }

    fn begin_reload(&mut self, index: usize) -> bool {
        let a = &mut self.actors[index];
        let w = weapon(a.faction);
        if !a.alive
            || a.spectator
            || a.selected_weapon != WeaponSlot::Rifle
            || a.switching(self.time)
            || self.time - a.last_melee_time < MELEE_SECONDS
            || a.reload > 0.0
            || a.ammo >= w.capacity
            || a.reserve == 0
        {
            return false;
        }
        a.reload_total = w.reload
            * if a.faction == Faction::British && a.ammo >= 5 {
                0.66
            } else {
                1.0
            };
        a.reload = a.reload_total;
        a.ads = false;
        true
    }

    fn move_actor(&mut self, index: usize, input: &InputFrame, jump: bool, dt: f64) {
        let mut a = self.actors[index].clone();
        let was_grounded = a.grounded;
        let (old_x, old_z) = (a.x, a.z);
        if jump && a.grounded {
            if a.stance != Stance::Stand {
                a.stance = Stance::Stand;
            } else {
                a.vy = JUMP_SPEED;
                a.grounded = false;
                a.ads = false;
                a.jump_started = self.time;
            }
        }
        let target = a.stance.height();
        a.eye_height += (target - a.eye_height) * (1.0 - (-LN_10 * dt / 0.18).exp());
        if (a.eye_height - target).abs() < 0.001 {
            a.eye_height = target;
        }
        let old_y = a.y;
        let airborne = !a.grounded;
        if !a.grounded || a.y > 0.0 {
            a.vy -= GRAVITY * dt;
            a.y += a.vy * dt;
        }
        let impact_speed = (-a.vy).max(0.0);
        if a.y <= 0.0 {
            a.y = 0.0;
            a.vy = 0.0;
            a.grounded = true;
        }
        for b in &self.boxes {
            if a.x > b.x - b.w / 2.0 - 0.18
                && a.x < b.x + b.w / 2.0 + 0.18
                && a.z > b.z - b.d / 2.0 - 0.18
                && a.z < b.z + b.d / 2.0 + 0.18
                && old_y >= b.h - 0.08
                && a.y <= b.h
                && a.vy <= 0.0
            {
                a.y = b.h;
                a.vy = 0.0;
                a.grounded = true;
            }
        }
        if !a.grounded {
            a.ads = false;
        }
        let speed = 4.8
            * stance_speed(a.eye_height)
            * if a.ads { 0.58 } else { 1.0 }
            * if a.selected_weapon == WeaponSlot::Grenade && !a.switching(self.time) {
                1.08
            } else {
                1.0
            };
        let length = input.forward.hypot(input.right).max(1.0);
        let f = input.forward / length;
        let r = input.right / length;
        let walk = if input.walk { 0.55 } else { 1.0 };
        let dx = (a.yaw.sin() * f - a.yaw.cos() * r) * walk * speed * dt;
        let dz = (a.yaw.cos() * f + a.yaw.sin() * r) * walk * speed * dt;
        let (x, z, distance) = resolve_movement(&a, &self.actors, &self.boxes, dx, dz);
        a.x = x;
        a.z = z;
        if a.y > 0.0
            && !self.boxes.iter().any(|b| {
                (a.y - b.h).abs() < 0.1
                    && (a.x - b.x).abs() < b.w / 2.0 + 0.18
                    && (a.z - b.z).abs() < b.d / 2.0 + 0.18
            })
        {
            a.grounded = false;
        }
        if !a.grounded {
            a.ads = false;
        }
        if was_grounded && !a.grounded {
            a.left_ground_at = self.time;
        }
        if airborne && a.grounded {
            a.landed_at = self.time;
            a.landing_speed = impact_speed;
        } else if was_grounded && !a.grounded && !airborne {
            a.jump_started = UNSET;
        }
        a.moving = distance / dt.max(0.001);
        advance_motion(&mut a, dt, old_x, old_z);
        self.actors[index] = a;
    }

    fn record(&mut self) {
        if self
            .history
            .back()
            .is_some_and(|frame| frame.time == self.time)
        {
            self.history.pop_back();
        }
        self.history.push_back(HistoryFrame {
            time: self.time,
            actors: self.actors.clone(),
        });
        while self
            .history
            .front()
            .is_some_and(|s| self.time - s.time > MAX_REWIND + 0.1)
        {
            self.history.pop_front();
        }
    }

    fn rewind_targets(&self, requested: Option<f64>) -> Vec<Actor> {
        let query = requested
            .unwrap_or(self.time)
            .clamp((self.time - MAX_REWIND).max(0.0), self.time);
        let Some(after) = self.history.iter().find(|s| s.time >= query) else {
            return self.actors.clone();
        };
        let before = self
            .history
            .iter()
            .rev()
            .find(|s| s.time <= query)
            .unwrap_or(after);
        let t = if after.time > before.time {
            (query - before.time) / (after.time - before.time)
        } else {
            0.0
        };
        before
            .actors
            .iter()
            .filter_map(|old| {
                let current = self.actor(old.id)?;
                let next = after.actors.iter().find(|a| a.id == old.id)?;
                // History from a former life never grants hits on a fresh respawn.
                if old.spawn_generation != current.spawn_generation
                    || next.spawn_generation != current.spawn_generation
                {
                    return None;
                }
                let mut result = old.clone();
                result.x = lerp(old.x, next.x, t);
                result.y = lerp(old.y, next.y, t);
                result.z = lerp(old.z, next.z, t);
                result.eye_height = lerp(old.eye_height, next.eye_height, t);
                result.pitch = lerp(old.pitch, next.pitch, t);
                result.recoil = lerp(old.recoil, next.recoil, t);
                result.moving = lerp(old.moving, next.moving, t);
                if let (Some(a), Some(b)) = (old.pose, next.pose) {
                    result.pose = Some(MotionPose::interpolate(a, b, t));
                }
                if old.reload > 0.0 && next.reload > 0.0 && old.reload_total == next.reload_total {
                    result.reload = lerp(old.reload, next.reload, t);
                }
                result.lean = lerp(old.lean, next.lean, t);
                let angle = (next.yaw - old.yaw).sin().atan2((next.yaw - old.yaw).cos());
                result.yaw = old.yaw + angle * t;
                // Require alive and unprotected in both current and historical worlds.
                result.alive = old.alive && current.alive && !current.spectator;
                result.lean = constrain_lean(&result, result.lean, &self.boxes);
                result.spawn_safe = old.spawn_safe.max(current.spawn_safe);
                Some(result)
            })
            .collect()
    }

    fn fire(&mut self, index: usize, melee: bool, attack: &PendingAttack) {
        let a = &self.actors[index];
        // Primary fire with the carried grenade is a bash, never a throw.
        let melee = melee || a.selected_weapon == WeaponSlot::Grenade;
        if !a.alive
            || a.spectator
            || a.switching(self.time)
            || (a.stance == Stance::Prone && a.moving > 0.1)
            || a.cooldown > 0.0
            || (!melee && a.reload > 0.0)
        {
            return;
        }
        if !melee && a.ammo == 0 {
            self.reload(index, Some(attack.seq));
            return;
        }
        let a = &mut self.actors[index];
        if !a.can_ads(self.time) {
            a.ads = false;
        }
        if melee {
            // Cancel only after all attack gates pass. Reload rounds transfer
            // at completion, so interruption must not modify either ammo pool.
            a.reload = 0.0;
            a.reload_total = 0.0;
            a.last_melee_time = self.time;
        } else {
            a.ammo -= 1;
            a.shots += 1;
            a.last_shot_time = self.time;
        }
        a.spawn_safe = 0.0;
        a.cooldown = if melee {
            MELEE_SECONDS
        } else {
            weapon(a.faction).cycle
        };
        let origin = a.eye();
        let spread = if melee {
            0.0
        } else if a.ads {
            0.0015
        } else {
            a.hip_spread
        };
        let recoil = a.recoil;
        let melee_damage = if a.selected_weapon == WeaponSlot::Grenade {
            75
        } else {
            150
        };
        let shooter_id = a.id;
        if let Some(control) = self.controls.get_mut(&shooter_id) {
            let age = (self.time - attack.shot_time.unwrap_or(self.time)).max(0.0);
            control.timing.shots = control.timing.shots.saturating_add(1);
            control.timing.shot_age_ms = age * 1000.0;
            if age > MAX_REWIND + 1e-8 {
                control.timing.rewind_clamped = control.timing.rewind_clamped.saturating_add(1);
            }
        }
        let yaw = attack.yaw + (self.random() - 0.5) * spread;
        let pitch = attack.pitch + recoil + (self.random() - 0.5) * spread;
        let direction = Vec3 {
            x: yaw.sin() * pitch.cos(),
            y: pitch.sin(),
            z: yaw.cos() * pitch.cos(),
        };
        let mut length =
            world_hit(&self.boxes, origin, direction).min(if melee { 1.85 } else { 120.0 });
        let mut victim = None;
        let mut damage = 108;
        let mut headshot = false;
        for target in self.rewind_targets(attack.shot_time) {
            if target.id == shooter_id
                || !target.alive
                || target.spectator
                || target.spawn_safe > 0.0
            {
                continue;
            }
            let query_time = attack
                .shot_time
                .unwrap_or(self.time)
                .clamp((self.time - MAX_REWIND).max(0.0), self.time);
            if let Some(hit) =
                ray_hit_volumes(origin, direction, &sample_hit_volumes(&target, query_time))
                && hit.distance < length
            {
                length = hit.distance;
                victim = Some(target.id);
                damage = if melee {
                    melee_damage
                } else {
                    hit.part.damage()
                };
                headshot = !melee && hit.part == HitPart::Head;
            }
        }
        let shot = Shot {
            time: self.time,
            actor: shooter_id,
            origin,
            end: Vec3 {
                x: origin.x + direction.x * length,
                y: origin.y + direction.y * length,
                z: origin.z + direction.z * length,
            },
            hit: victim,
            headshot,
            kind: if melee { "melee" } else { "shot" }.into(),
            seq: attack.seq,
        };
        let mut event = GameEvent::new("shot", shooter_id, Some(attack.seq));
        event.shot = Some(shot);
        self.events.push(event);
        if !melee {
            self.actors[index].recoil += weapon(self.actors[index].faction).recoil;
        }
        if let Some(victim) = victim {
            if !melee {
                self.actors[index].hits += 1;
            }
            self.damage(victim, shooter_id, damage, headshot, melee, attack.seq);
        }
    }

    fn damage(
        &mut self,
        victim: u32,
        killer: u32,
        amount: u32,
        headshot: bool,
        melee: bool,
        seq: u64,
    ) {
        let Some(source) = self.actor(killer).map(|a| (a.x, a.z)) else {
            return;
        };
        let now = self.time;
        let Some(target) = self.actor_mut(victim) else {
            return;
        };
        if !target.alive || target.spectator || amount == 0 {
            return;
        }
        let amount = if headshot {
            amount.max(target.hp)
        } else {
            amount
        };
        target.hp = target.hp.saturating_sub(amount);
        target.recoil += 0.026;
        target.last_hurt_time = now;
        let killed = target.hp == 0;
        if killed {
            target.alive = false;
            target.deaths += 1;
            target.dead_at = now;
            target.moving = 0.0;
            target.ads = false;
            target.death_yaw = (target.x - source.0).atan2(target.z - source.1);
            target.death_headshot = headshot;
        }
        let mut hurt = GameEvent::new("hurt", victim, Some(seq));
        hurt.value = Some(f64::from(amount));
        self.events.push(hurt);
        if killed {
            if let Some(killer_actor) = self.actor_mut(killer) {
                killer_actor.kills += if victim == killer { -1 } else { 1 };
            }
            let mut event = GameEvent::new("kill", killer, Some(seq));
            event.victim = Some(victim);
            event.headshot = Some(headshot);
            event.weapon = Some(if melee { "melee" } else { "rifle" }.into());
            self.events.push(event);
        }
    }
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}
/// Color codes are presentation, never identity. Bound raw and visible lengths
/// separately and discard control/bidi characters before names leave the server.
pub fn sanitize_name(name: &str) -> String {
    let raw:Vec<_>=name.chars().take(96).filter(|c|!matches!(*c,'\u{200b}'|'\u{200e}'|'\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2060}'|'\u{2066}'..='\u{2069}'|'\u{feff}')).collect();
    let mut points: Vec<(char, char, bool)> = Vec::new();
    let mut color = '7';
    let mut explicit = false;
    let mut i = 0;
    while i < raw.len() && points.len() < 24 {
        let c = raw[i];
        if c == '^' && i + 1 < raw.len() && raw[i + 1].is_ascii_digit() {
            color = raw[i + 1];
            explicit = true;
            i += 2;
            continue;
        }
        let c = if c.is_control() || c.is_whitespace() {
            ' '
        } else {
            c
        };
        if c != ' ' || (!points.is_empty() && points.last().is_some_and(|p| p.0 != ' ')) {
            points.push((c, color, explicit));
        }
        i += 1;
    }
    while points.last().is_some_and(|p| p.0 == ' ') {
        points.pop();
    }
    if points.is_empty() {
        return DEFAULT_PLAYER_NAME.into();
    }
    let mut result = String::new();
    let mut active = '7';
    for (i, (c, color, explicit)) in points.into_iter().enumerate() {
        if color != active || (i == 0 && explicit) || (result.ends_with('^') && c.is_ascii_digit())
        {
            result.push('^');
            result.push(color);
            active = color;
        }
        result.push(c);
    }
    result
}
fn stance_speed(height: f64) -> f64 {
    if height >= 1.05 {
        lerp(0.58, 1.0, ((height - 1.05) / (1.65 - 1.05)).clamp(0.0, 1.0))
    } else {
        lerp(
            0.23,
            0.58,
            ((height - 0.43) / (1.05 - 0.43)).clamp(0.0, 1.0),
        )
    }
}
fn player_spread(stance: Stance, moving: f64) -> f64 {
    let factor = match stance {
        Stance::Stand => 1.0,
        Stance::Crouch => 0.6,
        Stance::Prone => 0.5,
    };
    let spread = 2.0 * (0.037 * factor + moving * 0.008);
    2.0 * ((spread / 2.0).tan() * 1.21 * if stance == Stance::Prone { 1.15 } else { 1.0 }).atan()
}
fn blocked(boxes: &[WorldBox], x: f64, z: f64, y: f64) -> bool {
    boxes.iter().any(|b| {
        y < b.h - 0.08
            && x > b.x - b.w / 2.0 - RADIUS
            && x < b.x + b.w / 2.0 + RADIUS
            && z > b.z - b.d / 2.0 - RADIUS
            && z < b.z + b.d / 2.0 + RADIUS
    })
}

/// Kept identical to src/lean.ts: sweep the entire lateral camera segment,
/// including clearance over crate tops and the arena's boundary walls.
fn constrain_lean(a: &Actor, desired: f64, boxes: &[WorldBox]) -> f64 {
    let desired = desired.clamp(-1.0, 1.0);
    let distance = desired.abs() * LEAN_DISTANCE;
    if distance < 1e-9 {
        return 0.0;
    }
    let start = Vec3 {
        x: a.x,
        y: a.y + a.eye_height,
        z: a.z,
    };
    let delta = Vec3 {
        x: -a.yaw.cos() * desired * LEAN_DISTANCE,
        y: 0.0,
        z: a.yaw.sin() * desired * LEAN_DISTANCE,
    };
    let mut fraction = 1.0;
    for b in boxes {
        let hit = ray_box(
            start,
            delta,
            Vec3 {
                x: b.x - b.w / 2.0 - LEAN_CAMERA_RADIUS,
                y: -LEAN_CAMERA_RADIUS,
                z: b.z - b.d / 2.0 - LEAN_CAMERA_RADIUS,
            },
            Vec3 {
                x: b.x + b.w / 2.0 + LEAN_CAMERA_RADIUS,
                y: b.h + LEAN_CAMERA_RADIUS,
                z: b.z + b.d / 2.0 + LEAN_CAMERA_RADIUS,
            },
        );
        if hit <= fraction {
            fraction = (hit - LEAN_SKIN / distance).max(0.0);
        }
    }
    if start.y < 7.0 + LEAN_CAMERA_RADIUS {
        for (origin, movement, extent) in [
            (start.x, delta.x, 21.0 / SQRT_2),
            (start.z, delta.z, 24.0 / SQRT_2),
        ] {
            if movement.abs() < 1e-9 {
                continue;
            }
            let edge = movement.signum() * (extent - LEAN_CAMERA_RADIUS);
            fraction = fraction.min(((edge - origin) / movement - LEAN_SKIN / distance).max(0.0));
        }
    }
    desired * fraction.clamp(0.0, 1.0)
}

fn ray_box(o: Vec3, d: Vec3, min: Vec3, max: Vec3) -> f64 {
    let mut near = f64::NEG_INFINITY;
    let mut far = f64::INFINITY;
    for (o, d, min, max) in [
        (o.x, d.x, min.x, max.x),
        (o.y, d.y, min.y, max.y),
        (o.z, d.z, min.z, max.z),
    ] {
        if d.abs() < 1e-8 {
            if o < min || o > max {
                return f64::INFINITY;
            }
            continue;
        }
        let a = (min - o) / d;
        let b = (max - o) / d;
        near = near.max(a.min(b));
        far = far.min(a.max(b));
    }
    if far >= near.max(0.0) {
        near.max(0.0)
    } else {
        f64::INFINITY
    }
}
fn world_hit(boxes: &[WorldBox], o: Vec3, d: Vec3) -> f64 {
    let mut length = f64::INFINITY;
    for b in boxes {
        length = length.min(ray_box(
            o,
            d,
            Vec3 {
                x: b.x - b.w / 2.0,
                y: 0.0,
                z: b.z - b.d / 2.0,
            },
            Vec3 {
                x: b.x + b.w / 2.0,
                y: b.h,
                z: b.z + b.d / 2.0,
            },
        ));
    }
    if d.y < 0.0 {
        length = length.min(-o.y / d.y);
    }
    length
}
fn visible(boxes: &[WorldBox], a: Vec3, b: Vec3) -> bool {
    let length = ((b.x - a.x).powi(2) + (b.y - a.y).powi(2) + (b.z - a.z).powi(2)).sqrt();
    length < 1e-9
        || world_hit(
            boxes,
            a,
            Vec3 {
                x: (b.x - a.x) / length,
                y: (b.y - a.y) / length,
                z: (b.z - a.z) / length,
            },
        ) > length - 0.1
}

#[derive(Clone, Copy)]
struct Contact {
    time: f64,
    nx: f64,
    nz: f64,
}
fn sweep_actor(x: f64, z: f64, vx: f64, vz: f64, other: &Actor) -> Option<Contact> {
    let sx = x - other.x;
    let sz = z - other.z;
    let squared = sx * sx + sz * sz;
    let length = squared.sqrt();
    let speed = vx * vx + vz * vz;
    let approach = sx * vx + sz * vz;
    if speed < 1e-10 {
        return None;
    }
    let diameter = RADIUS * 2.0;
    if squared <= (diameter + SKIN * 0.5).powi(2) {
        if approach >= -1e-10 {
            return None;
        }
        return Some(Contact {
            time: 0.0,
            nx: if length > SKIN {
                sx / length
            } else {
                -vx / speed.sqrt()
            },
            nz: if length > SKIN {
                sz / length
            } else {
                -vz / speed.sqrt()
            },
        });
    }
    if approach >= 0.0 {
        return None;
    }
    let discriminant = approach * approach - speed * (squared - diameter * diameter);
    if discriminant < 0.0 {
        return None;
    }
    let time = (-approach - discriminant.sqrt()) / speed;
    if !(0.0..=1.0).contains(&time) {
        return None;
    }
    let hx = sx + vx * time;
    let hz = sz + vz * time;
    let length = hx.hypot(hz);
    Some(Contact {
        time,
        nx: hx / length,
        nz: hz / length,
    })
}
fn sweep_world(boxes: &[WorldBox], a: &Actor, x: f64, z: f64, vx: f64, vz: f64) -> Option<Contact> {
    if !blocked(boxes, x + vx, z + vz, a.y) {
        return None;
    }
    let mut lo = 0.0;
    let mut hi = 1.0;
    for _ in 0..18 {
        let t = (lo + hi) * 0.5;
        if blocked(boxes, x + vx * t, z + vz * t, a.y) {
            hi = t;
        } else {
            lo = t;
        }
    }
    let px = x + vx * lo;
    let pz = z + vz * lo;
    let hit_x = vx.abs() > 1e-10 && blocked(boxes, px + vx.signum() * 0.0002, pz, a.y);
    let hit_z = vz.abs() > 1e-10 && blocked(boxes, px, pz + vz.signum() * 0.0002, a.y);
    if hit_x && !hit_z {
        return Some(Contact {
            time: lo,
            nx: -vx.signum(),
            nz: 0.0,
        });
    }
    if hit_z && !hit_x {
        return Some(Contact {
            time: lo,
            nx: 0.0,
            nz: -vz.signum(),
        });
    }
    let length = vx.hypot(vz);
    Some(Contact {
        time: lo,
        nx: -vx / length,
        nz: -vz / length,
    })
}
fn resolve_movement(
    a: &Actor,
    actors: &[Actor],
    boxes: &[WorldBox],
    dx: f64,
    dz: f64,
) -> (f64, f64, f64) {
    let mut others: Vec<_> = actors
        .iter()
        .filter(|b| {
            b.id != a.id
                && b.alive
                && !b.spectator
                && a.y < b.y + b.eye_height + 0.18 - SKIN
                && a.y + a.eye_height + 0.18 > b.y + SKIN
        })
        .collect();
    others.sort_by_key(|b| b.id);
    let mut x = a.x;
    let mut z = a.z;
    let mut travelled = 0.0;
    let diameter = RADIUS * 2.0;
    let penetration = |x: f64, z: f64| {
        others
            .iter()
            .map(|b| (diameter - (x - b.x).hypot(z - b.z)).max(0.0).powi(2))
            .sum::<f64>()
    };
    for _ in 0..8 {
        let mut corrected = false;
        for b in &others {
            let sx = x - b.x;
            let sz = z - b.z;
            let distance = sx.hypot(sz);
            if distance >= diameter - SKIN {
                continue;
            }
            let fallback = (a.id.min(b.id).wrapping_add(1).wrapping_mul(73856093))
                ^ (a.id.max(b.id).wrapping_add(1).wrapping_mul(19349663));
            let direction = if distance > SKIN {
                sz.atan2(sx)
            } else {
                f64::from(fallback % 360) * PI / 180.0 + if a.id < b.id { PI } else { 0.0 }
            };
            let before = penetration(x, z);
            let mut best: Option<(f64, f64, f64, f64)> = None;
            for angle in [
                0.0,
                PI / 8.0,
                -PI / 8.0,
                PI / 4.0,
                -PI / 4.0,
                PI / 2.0,
                -PI / 2.0,
            ] {
                let nx = (direction + angle).cos();
                let nz = (direction + angle).sin();
                let along = sx * nx + sz * nz;
                let length = -along
                    + (along * along + (diameter + SKIN).powi(2) - distance * distance)
                        .max(0.0)
                        .sqrt();
                let tx = x + nx * length;
                let tz = z + nz * length;
                let steps = (length / 0.04).ceil().max(1.0) as usize;
                if (1..=steps).any(|i| {
                    blocked(
                        boxes,
                        lerp(x, tx, i as f64 / steps as f64),
                        lerp(z, tz, i as f64 / steps as f64),
                        a.y,
                    )
                }) {
                    continue;
                }
                let score = penetration(tx, tz);
                if score > before + 1e-10 {
                    continue;
                }
                if best.is_none_or(|b| {
                    score < b.2 - 1e-10 || ((score - b.2).abs() <= 1e-10 && length < b.3)
                }) {
                    best = Some((tx, tz, score, length));
                }
            }
            if let Some((tx, tz, _, _)) = best {
                x = tx;
                z = tz;
                corrected = true;
            }
        }
        if !corrected {
            break;
        }
    }
    let steps = (dx.hypot(dz) / 0.12).ceil().max(1.0) as usize;
    for _ in 0..steps {
        let mut vx = dx / steps as f64;
        let mut vz = dz / steps as f64;
        for _ in 0..6 {
            let length = vx.hypot(vz);
            if length < SKIN {
                break;
            }
            let mut hit = sweep_world(boxes, a, x, z, vx, vz);
            for other in &others {
                if let Some(contact) = sweep_actor(x, z, vx, vz, other)
                    && hit.is_none_or(|h| contact.time < h.time)
                {
                    hit = Some(contact);
                }
            }
            let Some(hit) = hit else {
                x += vx;
                z += vz;
                travelled += length;
                break;
            };
            let t = (hit.time - SKIN / length).max(0.0);
            let mx = vx * t;
            let mz = vz * t;
            x += mx;
            z += mz;
            travelled += mx.hypot(mz);
            vx *= 1.0 - t;
            vz *= 1.0 - t;
            let inward = vx * hit.nx + vz * hit.nz;
            if inward < 0.0 {
                vx -= inward * hit.nx;
                vz -= inward * hit.nz;
            } else {
                break;
            }
        }
    }
    (x, z, travelled)
}

#[cfg(test)]
#[path = "input_timing_tests.rs"]
mod input_timing_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn arena(count: u32) -> Simulation {
        let mut sim = Simulation::new(51235);
        for id in 1..=count {
            sim.join(id, format!("Player {id}"), Faction::British)
                .unwrap();
            let a = sim.actor_mut(id).unwrap();
            a.x = 13.6;
            a.z = -6.0 + f64::from(id - 1) * 4.0;
            a.yaw = 0.0;
            a.cooldown = 0.0;
            a.spawn_safe = 0.0;
        }
        sim.history.clear();
        sim.record();
        sim.events.clear();
        sim
    }
    fn input(sim: &mut Simulation, id: u32, mut frame: InputFrame) {
        frame.seq = sim.controls.get(&id).unwrap().latest.seq + 1;
        assert!(sim.submit_input(id, frame));
    }
    fn advance(sim: &mut Simulation, seconds: f64) {
        let mut remaining = seconds;
        while remaining > 1e-9 {
            let dt = remaining.min(TICK_SECONDS);
            sim.tick(dt);
            remaining -= dt;
        }
    }
    fn shoot(sim: &mut Simulation, id: u32, pitch: f64, melee: bool) {
        input(
            sim,
            id,
            InputFrame {
                ads: true,
                fire: !melee,
                melee,
                pitch,
                ..Default::default()
            },
        );
        sim.tick(TICK_SECONDS);
    }

    #[test]
    fn admission_caps_players_and_spawn_uses_safe_full_loadout() {
        let mut sim = Simulation::new(33);
        for id in 0..6 {
            sim.join(
                id,
                "^1Test".into(),
                [Faction::British, Faction::Russian, Faction::German][id as usize % 3],
            )
            .unwrap();
        }
        assert!(sim.join(6, "Full".into(), Faction::German).is_err());
        assert!(sim.join(1, "Duplicate".into(), Faction::German).is_err());
        for a in &sim.actors {
            assert_eq!(a.ammo, weapon(a.faction).capacity);
            assert_eq!(a.ammo + a.reserve, 150);
            assert!(!blocked(&sim.boxes, a.x, a.z, a.y));
            assert!(a.spawn_safe > 0.0);
            for b in &sim.actors {
                if a.id != b.id {
                    assert!((a.x - b.x).hypot(a.z - b.z) >= RADIUS * 2.0);
                }
            }
        }
        assert!(sim.leave(2));
        assert!(!sim.leave(2));
        assert!(sim.join(6, "New".into(), Faction::German).is_ok());
    }

    #[test]
    fn names_are_bounded_and_safe_without_losing_color_codes() {
        assert_eq!(sanitize_name("  ^7Chri^9s\u{202e}\n"), "^7Chri^9s");
        for blank in ["", " \n\t ", "^1^2  ", "\u{202e}\u{200b}"] {
            assert_eq!(sanitize_name(blank), "Unknown Soldier");
        }
        assert_eq!(sanitize_name("Player"), "Player");
        assert_eq!(sanitize_name(&"a".repeat(500)).chars().count(), 24);
        assert_eq!(sanitize_name("   A\n  B  "), "A B");
    }

    #[test]
    fn spectator_join_counts_toward_capacity_and_ignores_all_combat_intent() {
        let mut sim = Simulation::new(11);
        sim.join_participant(1, "Observer".into(), Faction::British, true)
            .unwrap();
        let before = sim.actor(1).unwrap().clone();
        assert!(before.spectator && !before.alive);
        assert!(
            sim.events.is_empty(),
            "observers never create a spawn/death effect"
        );
        for id in 2..=6 {
            sim.join(id, "Player".into(), Faction::German).unwrap();
        }
        assert!(
            sim.join_participant(7, "Full".into(), Faction::Russian, true)
                .is_err()
        );
        sim.events.clear();
        input(
            &mut sim,
            1,
            InputFrame {
                forward: 1.0,
                right: 1.0,
                jump: true,
                lean: 1.0,
                ads: true,
                fire: true,
                melee: true,
                reload: true,
                yaw: 2.0,
                pitch: 1.0,
                stance: Some(Stance::Prone),
                weapon: Some(WeaponSlot::Grenade),
                ..Default::default()
            },
        );
        advance(&mut sim, 5.0);
        let a = sim.actor(1).unwrap();
        assert!(a.spectator && !a.alive);
        assert_eq!(
            (a.x, a.y, a.z, a.yaw, a.pitch),
            (before.x, before.y, before.z, before.yaw, before.pitch)
        );
        assert_eq!(
            (a.ammo, a.reserve, a.shots, a.kills, a.deaths),
            (before.ammo, before.reserve, 0, 0, 0)
        );
        assert_eq!((a.lean, a.reload, a.cooldown), (0.0, 0.0, 0.0));
        assert_eq!(a.ack, 1);
        assert!(sim.events.iter().all(|event| event.actor != 1));
    }

    #[test]
    fn spectating_clears_pending_actions_without_death_and_returns_via_loadout() {
        let mut sim = arena(1);
        let a = sim.actor_mut(1).unwrap();
        a.kills = 3;
        a.deaths = 2;
        a.reload = 1.0;
        a.reload_total = 2.0;
        a.cooldown = 0.5;
        a.lean = 1.0;
        input(
            &mut sim,
            1,
            InputFrame {
                fire: true,
                melee: true,
                reload: true,
                forward: 1.0,
                ..Default::default()
            },
        );
        assert!(sim.spectate(1));
        assert!(!sim.spectate(1));
        sim.tick(TICK_SECONDS);
        let a = sim.actor(1).unwrap();
        assert_eq!(
            (a.kills, a.deaths, a.reload, a.reload_total, a.cooldown),
            (3, 2, 0.0, 0.0, 0.0)
        );
        assert!(sim.events.is_empty());
        assert!(
            sim.change_faction(1, Faction::British),
            "same faction also exits spectator"
        );
        let a = sim.actor(1).unwrap();
        assert!(!a.spectator && a.alive);
        assert_eq!((a.kills, a.deaths, a.ammo + a.reserve), (3, 2, 150));
        assert!(a.spawn_safe > 0.0);
        assert_eq!(
            sim.events
                .iter()
                .map(|e| e.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["spawn"]
        );
        sim.tick(TICK_SECONDS);
        assert_eq!(
            sim.actor(1).unwrap().shots,
            0,
            "old intent cannot fire after returning"
        );
    }

    #[test]
    fn spectators_are_never_targets_or_obstacles_even_to_rewound_shots() {
        let mut sim = arena(2);
        sim.actor_mut(2).unwrap().z = -4.8;
        sim.history.clear();
        sim.record();
        sim.spectate(2);
        input(
            &mut sim,
            1,
            InputFrame {
                fire: true,
                ads: true,
                shot_time: Some(0.0),
                ..Default::default()
            },
        );
        sim.tick(TICK_SECONDS);
        assert_eq!(
            (sim.actor(1).unwrap().kills, sim.actor(2).unwrap().deaths),
            (0, 0)
        );
        assert!(
            sim.events
                .iter()
                .filter_map(|e| e.shot.as_ref())
                .all(|s| s.hit.is_none())
        );
        // Ordinary movement crosses the former body's exact position.
        for _ in 0..30 {
            input(
                &mut sim,
                1,
                InputFrame {
                    forward: 1.0,
                    ..Default::default()
                },
            );
            sim.tick(TICK_SECONDS);
        }
        assert!(sim.actor(1).unwrap().z > -4.2);
        let deaths = sim.actor(2).unwrap().deaths;
        sim.damage(2, 1, 100, true, false, 5);
        assert_eq!(sim.actor(2).unwrap().deaths, deaths);
    }

    #[test]
    fn round_restarts_preserve_observers_and_exclude_them_from_winners() {
        let mut sim = arena(2);
        sim.actor_mut(2).unwrap().kills = 100;
        sim.spectate(2);
        sim.finish();
        assert_eq!(sim.winner, Some(1));
        sim.events.clear();
        sim.restart_round();
        assert!(sim.actor(1).unwrap().alive);
        assert!(sim.actor(2).unwrap().spectator && !sim.actor(2).unwrap().alive);
        assert!(sim.events.iter().all(|e| e.actor != 2));
        sim.spectate(1);
        sim.finish();
        assert_eq!(sim.winner, None);
    }

    #[test]
    fn lean_camera_sweeps_walls_corners_and_thin_cover_without_zero_reset() {
        let mut a = Actor::new(1, "Test".into(), Faction::British);
        a.x = -21.0 / SQRT_2 + 0.31;
        let partial = constrain_lean(&a, 1.0, &[]);
        assert!((partial - (0.31 - LEAN_CAMERA_RADIUS - LEAN_SKIN) / LEAN_DISTANCE).abs() < 1e-9);
        let mut previous = 0.0;
        for _ in 0..240 {
            a.lean = constrain_lean(
                &a,
                a.lean + (1.0 - a.lean) * (1.0 - (-12.0 * TICK_SECONDS).exp()),
                &[],
            );
            assert!(a.lean >= previous - 1e-10);
            previous = a.lean;
        }
        assert!((a.lean - partial).abs() < 1e-9);
        a.z = -24.0 / SQRT_2 + 0.31;
        a.yaw = -PI / 4.0;
        let corner = constrain_lean(&a, 1.0, &[]);
        assert!(
            (corner - (0.31 - LEAN_CAMERA_RADIUS - LEAN_SKIN / SQRT_2) / (LEAN_DISTANCE / SQRT_2))
                .abs()
                < 1e-9
        );
        a.x = 0.0;
        a.z = 0.0;
        a.yaw = 0.0;
        let thin = [WorldBox {
            x: -0.21,
            z: 0.0,
            w: 0.02,
            d: 1.0,
            h: 2.0,
        }];
        assert!(
            (constrain_lean(&a, 1.0, &thin)
                - (0.21 - 0.01 - LEAN_CAMERA_RADIUS - LEAN_SKIN) / LEAN_DISTANCE)
                .abs()
                < 1e-9
        );
        assert_eq!(constrain_lean(&a, -1.0, &thin), -1.0);
    }

    #[test]
    fn lean_uses_transition_eye_height_and_clearance_above_crate_tops() {
        let mut a = Actor::new(1, "Test".into(), Faction::British);
        let cover = [WorldBox {
            x: -0.5,
            z: 0.0,
            w: 0.4,
            d: 1.0,
            h: 1.2,
        }];
        assert_eq!(constrain_lean(&a, 1.0, &cover), 1.0);
        a.eye_height = 1.2 + LEAN_CAMERA_RADIUS - 0.001;
        let partial = constrain_lean(&a, 1.0, &cover);
        assert!(partial > 0.0 && partial < 0.4);
        for h in [1.05, 0.43] {
            a.eye_height = h;
            assert_eq!(constrain_lean(&a, 1.0, &cover), partial);
        }
        a.y = 1.2;
        assert_eq!(constrain_lean(&a, 1.0, &cover), 1.0);
    }

    #[test]
    fn input_rejects_replays_nonfinite_and_impossible_payloads() {
        let mut sim = arena(1);
        assert!(!sim.submit_input(9, InputFrame::default()));
        assert!(!sim.submit_input(
            1,
            InputFrame {
                yaw: f64::NAN,
                ..Default::default()
            }
        ));
        assert!(!sim.submit_input(
            1,
            InputFrame {
                forward: f64::INFINITY,
                ..Default::default()
            }
        ));
        assert!(!sim.submit_input(
            1,
            InputFrame {
                shot_time: Some(f64::NAN),
                ..Default::default()
            }
        ));
        assert!(!sim.submit_input(
            1,
            InputFrame {
                seq: u64::MAX,
                ..Default::default()
            }
        ));
        assert!(sim.submit_input(
            1,
            InputFrame {
                seq: 2,
                forward: 1000.0,
                right: 1000.0,
                pitch: 30.0,
                ..Default::default()
            }
        ));
        assert!(!sim.submit_input(
            1,
            InputFrame {
                seq: 2,
                ..Default::default()
            }
        ));
        assert!(!sim.submit_input(
            1,
            InputFrame {
                seq: 1,
                ..Default::default()
            }
        ));
        let start = sim.actor(1).unwrap().clone();
        sim.tick(TICK_SECONDS);
        let end = sim.actor(1).unwrap();
        assert_eq!(end.ack, 2);
        assert_eq!(end.pitch, 1.45);
        assert!((end.x - start.x).hypot(end.z - start.z) <= 4.8 * TICK_SECONDS + 1e-9);
        assert!(
            serde_json::to_value(&sim.actors)
                .unwrap()
                .to_string()
                .contains("eyeHeight")
        );
    }

    #[test]
    fn flooding_packets_does_not_advance_time_or_multiply_actions() {
        let mut sim = arena(1);
        let start = sim.actor(1).unwrap().clone();
        for seq in 1..1001 {
            assert!(sim.submit_input(
                1,
                InputFrame {
                    seq,
                    forward: 1.0,
                    fire: true,
                    ..Default::default()
                }
            ));
        }
        assert_eq!(sim.time, 0.0);
        sim.tick(TICK_SECONDS);
        let a = sim.actor(1).unwrap();
        assert_eq!(a.shots, 1);
        assert_eq!(a.ammo, 9);
        assert_eq!(a.ack, 1000);
        assert!((a.z - start.z - 4.8 * TICK_SECONDS).abs() < 1e-9);
        assert_eq!(sim.events.iter().filter(|e| e.kind == "shot").count(), 1);
        assert_eq!(
            sim.events.iter().find(|e| e.kind == "shot").unwrap().seq,
            Some(1)
        );
    }

    #[test]
    fn input_timeout_and_disconnect_stop_motion_without_client_authority() {
        let mut sim = arena(1);
        let z = sim.actor(1).unwrap().z;
        input(
            &mut sim,
            1,
            InputFrame {
                forward: 1.0,
                ..Default::default()
            },
        );
        advance(&mut sim, 1.0);
        let p = sim.actor(1).unwrap();
        assert!(p.z > z + 0.9 && p.z <= z + 1.2 + 1e-8);
        assert_eq!(p.moving, 0.0);
        input(
            &mut sim,
            1,
            InputFrame {
                forward: 1.0,
                fire: true,
                ..Default::default()
            },
        );
        sim.neutralize(1);
        let z = sim.actor(1).unwrap().z;
        sim.tick(TICK_SECONDS);
        assert_eq!(sim.actor(1).unwrap().z, z);
        assert_eq!(sim.actor(1).unwrap().shots, 0);
    }

    #[test]
    fn gradual_stance_preserves_ads_and_actual_jump_cancels_it() {
        let mut sim = arena(1);
        input(
            &mut sim,
            1,
            InputFrame {
                ads: true,
                stance: Some(Stance::Crouch),
                ..Default::default()
            },
        );
        sim.tick(TICK_SECONDS);
        let a = sim.actor(1).unwrap();
        assert!(a.eye_height > 1.05 && a.eye_height < 1.65);
        assert!(a.ads);
        for _ in 0..24 {
            input(
                &mut sim,
                1,
                InputFrame {
                    ads: true,
                    stance: Some(Stance::Crouch),
                    ..Default::default()
                },
            );
            sim.tick(TICK_SECONDS);
            assert!(sim.actor(1).unwrap().ads);
        }
        assert!((sim.actor(1).unwrap().eye_height - 1.05).abs() < 0.01);
        input(
            &mut sim,
            1,
            InputFrame {
                ads: true,
                jump: true,
                stance: Some(Stance::Crouch),
                ..Default::default()
            },
        );
        sim.tick(TICK_SECONDS);
        assert_eq!(sim.actor(1).unwrap().stance, Stance::Stand);
        assert!(sim.actor(1).unwrap().grounded);
        assert!(sim.actor(1).unwrap().ads);
        input(
            &mut sim,
            1,
            InputFrame {
                ads: true,
                jump: true,
                stance: Some(Stance::Stand),
                ..Default::default()
            },
        );
        sim.tick(TICK_SECONDS);
        assert!(!sim.actor(1).unwrap().grounded);
        assert!(!sim.actor(1).unwrap().ads);
        assert!(sim.actor(1).unwrap().y > 0.0);
        let jump = sim.actor(1).unwrap().jump_started;
        advance(&mut sim, 0.8);
        assert!(sim.actor(1).unwrap().grounded);
        assert_eq!(sim.actor(1).unwrap().y, 0.0);
        assert!(sim.actor(1).unwrap().landed_at > jump);
        assert!(sim.actor(1).unwrap().landing_speed > 6.0);
    }

    #[test]
    fn swept_actor_collision_blocks_tunneling_and_allows_sliding_and_vertical_clearance() {
        let mut a = Actor::new(1, "A".into(), Faction::British);
        a.x = -3.0;
        let b = Actor::new(2, "B".into(), Faction::German);
        let (x, z, d) = resolve_movement(&a, &[a.clone(), b.clone()], &[], 12.0, 0.0);
        assert!((x + 0.6).abs() < 0.0001);
        assert_eq!(z, 0.0);
        assert!((d - 2.4).abs() < 0.0001);
        a.x = -2.0;
        a.z = 0.44;
        let (x, z, d) = resolve_movement(&a, &[a.clone(), b.clone()], &[], 4.0, 0.0);
        assert!(x > 1.6 && z >= 0.6 && d > 3.7);
        a.z = 0.0;
        a.y = 1.84;
        let (x, _, _) = resolve_movement(&a, &[a.clone(), b.clone()], &[], 4.0, 0.0);
        assert!(x > 1.9);
        a.y = 1.82;
        let (x, _, _) = resolve_movement(&a, &[a.clone(), b.clone()], &[], 4.0, 0.0);
        assert!(x < -0.59);
        a.x = 0.0;
        a.y = 0.0;
        let (x, z, d) = resolve_movement(&a, &[a.clone(), b], &[], 0.0, 0.0);
        assert!(x.hypot(z) >= 0.6);
        assert_eq!(d, 0.0);
    }

    #[test]
    fn opposing_players_cannot_exchange_sides_or_walk_through_map_boundaries() {
        let mut sim = arena(2);
        sim.actor_mut(2).unwrap().z = -4.0;
        for _ in 0..90 {
            input(
                &mut sim,
                1,
                InputFrame {
                    forward: 1.0,
                    ..Default::default()
                },
            );
            input(
                &mut sim,
                2,
                InputFrame {
                    forward: 1.0,
                    yaw: PI,
                    ..Default::default()
                },
            );
            sim.tick(TICK_SECONDS);
            let a = sim.actor(1).unwrap();
            let b = sim.actor(2).unwrap();
            assert!(a.z < b.z);
            assert!((a.x - b.x).hypot(a.z - b.z) >= 0.6 - 1e-8);
        }
        let mut sim = arena(1);
        for _ in 0..600 {
            input(
                &mut sim,
                1,
                InputFrame {
                    forward: 1.0,
                    yaw: PI / 2.0,
                    ..Default::default()
                },
            );
            sim.tick(TICK_SECONDS);
        }
        let a = sim.actor(1).unwrap();
        assert!(a.x <= 42.0 / SQRT_2 / 2.0 - RADIUS + 1e-7);
        assert!(!blocked(&sim.boxes, a.x, a.z, a.y));
    }

    #[test]
    fn map_cover_occludes_bullets_and_lean_never_crosses_cover() {
        let mut sim = arena(2);
        let b = sim.boxes[0];
        let a = sim.actor_mut(1).unwrap();
        a.x = b.x;
        a.z = b.z - b.d / 2.0 - 1.0;
        let t = sim.actor_mut(2).unwrap();
        t.x = b.x;
        t.z = b.z + b.d / 2.0 + 1.0;
        sim.history.clear();
        sim.record();
        shoot(&mut sim, 1, 0.0, false);
        assert!(sim.actor(2).unwrap().alive);
        assert_eq!(sim.actor(2).unwrap().hp, 100);
        assert!(
            sim.events
                .iter()
                .find_map(|e| e.shot.as_ref())
                .unwrap()
                .hit
                .is_none()
        );
        let a = sim.actor_mut(1).unwrap();
        a.x = b.x - b.w / 2.0 - RADIUS - 0.01;
        a.z = b.z;
        a.yaw = 0.0;
        for _ in 0..60 {
            input(
                &mut sim,
                1,
                InputFrame {
                    lean: -1.0,
                    ..Default::default()
                },
            );
            sim.tick(TICK_SECONDS);
        }
        let eye = sim.actor(1).unwrap().eye();
        assert!(eye.x < b.x - b.w / 2.0);
        assert_eq!(sim.actor(1).unwrap().yaw, 0.0);
    }

    #[test]
    fn hipfire_projected_radius_is_ten_percent_wider_in_every_stance_and_speed() {
        for (stance, factor) in [
            (Stance::Stand, 1.0),
            (Stance::Crouch, 0.6),
            (Stance::Prone, 0.5),
        ] {
            for moving in [0.0, 0.3, 1.8, 2.4, 4.8, 5.376] {
                // Compare the physical ray-cone radius to the prior tuning,
                // including the separate prone correction. Angular scaling
                // alone would not keep the visible radius exactly 10% wider.
                let old_radius = (0.037_f64 * factor + moving * 0.008).tan()
                    * 1.1
                    * if stance == Stance::Prone { 1.15 } else { 1.0 };
                let new_radius = (player_spread(stance, moving) / 2.0).tan();
                assert!((new_radius / old_radius - 1.1).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn ads_shot_cone_is_unchanged_by_wider_hipfire_tuning() {
        for stance in [Stance::Stand, Stance::Crouch, Stance::Prone] {
            let mut narrow = arena(1);
            let mut wide = arena(1);
            for (sim, hip_spread) in [(&mut narrow, 0.01), (&mut wide, 0.4)] {
                let actor = sim.actor_mut(1).unwrap();
                actor.stance = stance;
                actor.eye_height = stance.height();
                actor.hip_spread = hip_spread;
                input(
                    sim,
                    1,
                    InputFrame {
                        ads: true,
                        fire: true,
                        stance: Some(stance),
                        ..Default::default()
                    },
                );
                sim.tick(TICK_SECONDS);
                assert!(sim.actor(1).unwrap().ads);
            }
            let shot = |sim: &Simulation| {
                sim.events
                    .iter()
                    .find_map(|event| event.shot.clone())
                    .unwrap()
            };
            let narrow_shot = shot(&narrow);
            let wide_shot = shot(&wide);
            assert_eq!(
                serde_json::to_value(&narrow_shot).unwrap(),
                serde_json::to_value(&wide_shot).unwrap()
            );
            let dx = wide_shot.end.x - wide_shot.origin.x;
            let dy = wide_shot.end.y - wide_shot.origin.y;
            let dz = wide_shot.end.z - wide_shot.origin.z;
            assert!(dx.atan2(dz).abs() <= 0.00075);
            assert!(dy.atan2(dx.hypot(dz)).abs() <= 0.00075);
        }
    }

    #[test]
    fn rifle_hit_regions_recoil_cooldown_and_ammo_are_server_owned() {
        for (name, damage) in [
            ("head", 180),
            ("chest", 108),
            ("abdomen", 96),
            ("thighL", 72),
            ("calfL", 60),
            ("footL", 48),
        ] {
            // Target actual anatomical parts, not the former continuous bands
            // whose centre filled the open space between both legs.
            let mut sim = arena(2);
            let volume = sample_hit_volumes(sim.actor(2).unwrap(), TICK_SECONDS)
                .into_iter()
                .find(|v| v.name == name)
                .unwrap();
            let mut point = volume.center;
            if name == "footL" {
                point.y = 0.025;
            }
            let eye = sim.actor(1).unwrap().eye();
            let dx = point.x - eye.x;
            let dz = point.z - eye.z;
            let pitch = (point.y - eye.y).atan2(dx.hypot(dz));
            input(
                &mut sim,
                1,
                InputFrame {
                    yaw: dx.atan2(dz),
                    pitch,
                    ads: true,
                    fire: true,
                    ..Default::default()
                },
            );
            sim.tick(TICK_SECONDS);
            let target = sim.actor(2).unwrap();
            assert_eq!(target.hp, 100_u32.saturating_sub(damage));
            assert_eq!(target.death_headshot, name == "head");
            let shooter = sim.actor(1).unwrap();
            assert_eq!(shooter.ammo, 9);
            assert_eq!(shooter.hits, 1);
            assert!((shooter.recoil - 0.07938).abs() < 1e-12);
            assert_eq!(shooter.cooldown, 1.08);
            shoot(&mut sim, 1, pitch, false);
            assert_eq!(sim.actor(1).unwrap().shots, 1);
        }
    }

    #[test]
    fn headshot_kills_score_once_and_respawn_restores_full_ammo() {
        let mut sim = arena(2);
        shoot(&mut sim, 1, 0.0, false);
        assert!(!sim.actor(2).unwrap().alive);
        assert_eq!(sim.actor(1).unwrap().kills, 1);
        assert_eq!(sim.actor(2).unwrap().deaths, 1);
        assert_eq!(sim.events.iter().filter(|e| e.kind == "kill").count(), 1);
        advance(&mut sim, 2.95);
        assert!(!sim.actor(2).unwrap().alive);
        advance(&mut sim, 0.1);
        let a = sim.actor(2).unwrap();
        assert!(a.alive);
        assert_eq!(a.ammo + a.reserve, 150);
        assert_eq!(a.deaths, 1);
        assert!(a.spawn_safe > 1.4);
    }

    #[test]
    fn protected_spawns_cannot_be_hit_and_firing_removes_protection() {
        let mut sim = arena(2);
        sim.actor_mut(2).unwrap().spawn_safe = 1.5;
        shoot(&mut sim, 1, 0.0, false);
        assert_eq!(sim.actor(2).unwrap().hp, 100);
        input(
            &mut sim,
            2,
            InputFrame {
                yaw: PI,
                fire: true,
                ..Default::default()
            },
        );
        sim.tick(TICK_SECONDS);
        assert_eq!(sim.actor(2).unwrap().spawn_safe, 0.0);
    }

    #[test]
    fn grenade_bash_preserves_movement_bonus_and_switch_cancels_reload_without_creating_ammo() {
        let mut sim = arena(1);
        sim.actor_mut(1).unwrap().ammo = 3;
        sim.actor_mut(1).unwrap().reserve = 17;
        input(
            &mut sim,
            1,
            InputFrame {
                reload: true,
                ..Default::default()
            },
        );
        sim.tick(TICK_SECONDS);
        assert!(sim.actor(1).unwrap().reload > 0.0);
        input(
            &mut sim,
            1,
            InputFrame {
                weapon: Some(WeaponSlot::Grenade),
                ..Default::default()
            },
        );
        sim.tick(TICK_SECONDS);
        assert_eq!(sim.actor(1).unwrap().reload, 0.0);
        advance(&mut sim, 0.61);
        let z = sim.actor(1).unwrap().z;
        input(
            &mut sim,
            1,
            InputFrame {
                weapon: Some(WeaponSlot::Grenade),
                forward: 1.0,
                fire: true,
                melee: true,
                reload: true,
                ads: true,
                ..Default::default()
            },
        );
        sim.tick(TICK_SECONDS);
        let a = sim.actor(1).unwrap();
        assert_eq!(a.shots, 0);
        assert_eq!(a.ammo, 3);
        assert_eq!(a.reserve, 17);
        assert_eq!(a.reload, 0.0);
        assert!(!a.ads);
        assert_eq!(a.last_melee_time, sim.time);
        assert_eq!(a.last_shot_time, UNSET);
        assert_eq!(a.recoil, 0.0);
        assert_eq!(
            sim.events
                .iter()
                .filter_map(|event| event.shot.as_ref())
                .count(),
            1,
            "simultaneous primary/melee inputs produce one bash"
        );
        assert!((a.z - z - 4.8 * 1.08 * TICK_SECONDS).abs() < 1e-9);
        input(
            &mut sim,
            1,
            InputFrame {
                weapon: Some(WeaponSlot::Rifle),
                ..Default::default()
            },
        );
        sim.tick(TICK_SECONDS);
        advance(&mut sim, MELEE_SECONDS + 0.01);
        input(
            &mut sim,
            1,
            InputFrame {
                reload: true,
                ..Default::default()
            },
        );
        sim.tick(TICK_SECONDS);
        advance(&mut sim, 3.26);
        assert_eq!(sim.actor(1).unwrap().ammo, 10);
        assert_eq!(sim.actor(1).unwrap().reserve, 10);
    }

    #[test]
    fn reload_drops_ads_before_the_same_ticks_movement() {
        let mut sim = arena(1);
        let a = sim.actor_mut(1).unwrap();
        a.ammo = 9;
        a.ads = true;
        let z = a.z;
        input(
            &mut sim,
            1,
            InputFrame {
                ads: true,
                forward: 1.0,
                reload: true,
                ..Default::default()
            },
        );
        sim.tick(TICK_SECONDS);
        let a = sim.actor(1).unwrap();
        assert!(!a.ads);
        assert!(a.reload > 0.0);
        assert!((a.z - z - 4.8 * TICK_SECONDS).abs() < 1e-9);
    }

    #[test]
    fn melee_has_short_range_and_cannot_be_spammed() {
        let mut sim = arena(2);
        sim.actor_mut(2).unwrap().z = -4.8;
        sim.history.clear();
        sim.record();
        shoot(&mut sim, 1, 0.0, true);
        assert!(!sim.actor(2).unwrap().alive);
        assert_eq!(sim.actor(1).unwrap().ammo, 10);
        assert_eq!(sim.actor(1).unwrap().shots, 0);
        assert_eq!(sim.actor(1).unwrap().cooldown, MELEE_SECONDS);
        shoot(&mut sim, 1, 0.0, true);
        assert_eq!(sim.events.iter().filter(|e| e.kind == "shot").count(), 1);
        let mut sim = arena(2);
        shoot(&mut sim, 1, 0.0, true);
        assert_eq!(sim.actor(2).unwrap().hp, 100);
    }

    #[test]
    fn melee_interrupts_reload_without_transferring_ammo_and_can_reload_after_recovery() {
        for faction in [Faction::British, Faction::Russian, Faction::German] {
            for ammo in [0, 3] {
                let mut sim = arena(2);
                let a = sim.actor_mut(1).unwrap();
                a.faction = faction;
                a.ammo = ammo;
                a.reserve = 17;
                sim.actor_mut(2).unwrap().z = -4.8;
                input(
                    &mut sim,
                    1,
                    InputFrame {
                        reload: true,
                        ..Default::default()
                    },
                );
                sim.tick(TICK_SECONDS);
                advance(&mut sim, 0.25);
                assert!(sim.actor(1).unwrap().reload > 0.0);

                shoot(&mut sim, 1, 0.0, true);
                let a = sim.actor(1).unwrap();
                assert_eq!((a.reload, a.reload_total), (0.0, 0.0));
                assert_eq!((a.ammo, a.reserve, a.shots), (ammo, 17, 0));
                assert_eq!(a.last_melee_time, sim.time);
                assert_eq!(a.cooldown, MELEE_SECONDS);
                assert!(
                    !sim.actor(2).unwrap().alive,
                    "interruption must perform the hit"
                );

                // A new R press cannot replace the accepted melee animation.
                sim.events.clear();
                input(
                    &mut sim,
                    1,
                    InputFrame {
                        reload: true,
                        ..Default::default()
                    },
                );
                sim.tick(TICK_SECONDS);
                let a = sim.actor(1).unwrap();
                assert_eq!((a.reload, a.reload_total), (0.0, 0.0));
                assert_eq!((a.ammo, a.reserve), (ammo, 17));
                assert!(sim.events.iter().all(|event| event.kind != "reload"));

                advance(&mut sim, MELEE_SECONDS + 0.02);
                input(
                    &mut sim,
                    1,
                    InputFrame {
                        reload: true,
                        ..Default::default()
                    },
                );
                sim.tick(TICK_SECONDS);
                assert!(sim.actor(1).unwrap().reload > 0.0);
                advance(&mut sim, weapon(faction).reload + 0.1);
                let a = sim.actor(1).unwrap();
                assert_eq!(a.ammo, weapon(faction).capacity);
                assert_eq!(a.ammo + a.reserve, ammo + 17);
            }
        }
    }

    #[test]
    fn simultaneous_reload_and_melee_performs_only_the_melee_without_reload_cue() {
        let mut sim = arena(1);
        let a = sim.actor_mut(1).unwrap();
        a.ammo = 3;
        a.reserve = 17;
        input(
            &mut sim,
            1,
            InputFrame {
                fire: true,
                melee: true,
                reload: true,
                ..Default::default()
            },
        );
        sim.tick(TICK_SECONDS);
        let a = sim.actor(1).unwrap();
        assert_eq!((a.reload, a.reload_total), (0.0, 0.0));
        assert_eq!((a.ammo, a.reserve, a.shots), (3, 17, 0));
        let shots: Vec<_> = sim
            .events
            .iter()
            .filter_map(|event| event.shot.as_ref())
            .collect();
        assert_eq!(shots.len(), 1);
        assert_eq!(shots[0].kind, "melee");
        assert_eq!(shots[0].seq, a.ack);
        assert!(sim.events.iter().all(|event| event.kind != "reload"));
    }

    #[test]
    fn blocked_melee_preserves_reload_for_cooldown_switching_prone_and_death() {
        for gate in ["cooldown", "switching", "prone", "dead"] {
            let mut sim = arena(1);
            let now = sim.time;
            let a = sim.actor_mut(1).unwrap();
            a.ammo = 3;
            a.reserve = 17;
            a.reload = 1.0;
            a.reload_total = 2.0;
            match gate {
                "cooldown" => a.cooldown = 0.5,
                "switching" => {
                    a.switch_started = now;
                    a.switch_duration = SWITCH_SECONDS;
                }
                "prone" => {
                    a.stance = Stance::Prone;
                    a.eye_height = Stance::Prone.height();
                }
                "dead" => {
                    a.alive = false;
                    a.dead_at = now;
                }
                _ => unreachable!(),
            }
            input(
                &mut sim,
                1,
                InputFrame {
                    melee: true,
                    forward: if gate == "prone" { 1.0 } else { 0.0 },
                    ..Default::default()
                },
            );
            sim.tick(TICK_SECONDS);
            let a = sim.actor(1).unwrap();
            assert!(a.reload > 0.9, "{gate} must not cancel reload");
            assert_eq!(a.reload_total, 2.0);
            assert_eq!((a.ammo, a.reserve), (3, 17));
            assert_eq!(a.last_melee_time, UNSET);
            assert!(sim.events.iter().all(|event| event.shot.is_none()));
        }
    }

    #[test]
    fn rejected_coalesced_melee_keeps_new_reload_and_emits_its_cue() {
        let mut sim = arena(1);
        let a = sim.actor_mut(1).unwrap();
        a.ammo = 3;
        a.stance = Stance::Prone;
        a.eye_height = Stance::Prone.height();
        input(
            &mut sim,
            1,
            InputFrame {
                melee: true,
                reload: true,
                forward: 1.0,
                ..Default::default()
            },
        );
        sim.tick(TICK_SECONDS);
        let a = sim.actor(1).unwrap();
        assert!(a.reload > 0.0);
        assert_eq!(a.last_melee_time, UNSET);
        assert!(sim.events.iter().all(|event| event.shot.is_none()));
        assert_eq!(
            sim.events
                .iter()
                .filter(|event| event.kind == "reload")
                .count(),
            1
        );
    }

    #[test]
    fn rifle_fire_cannot_interrupt_reload_and_completed_reload_is_not_undone_by_melee() {
        let mut sim = arena(1);
        let a = sim.actor_mut(1).unwrap();
        a.ammo = 3;
        a.reserve = 17;
        a.reload = 1.0;
        a.reload_total = 1.0;
        shoot(&mut sim, 1, 0.0, false);
        let a = sim.actor(1).unwrap();
        assert!(a.reload > 0.9);
        assert_eq!((a.ammo, a.reserve, a.shots), (3, 17, 0));
        assert!(sim.events.iter().all(|event| event.shot.is_none()));

        // Timers complete before this tick's intent, matching client prediction.
        sim.actor_mut(1).unwrap().reload = TICK_SECONDS / 2.0;
        shoot(&mut sim, 1, 0.0, true);
        let a = sim.actor(1).unwrap();
        assert_eq!((a.reload, a.reload_total), (0.0, 0.0));
        assert_eq!((a.ammo, a.reserve), (10, 10));
        assert_eq!(a.last_melee_time, sim.time);
    }

    #[test]
    fn grenade_primary_and_melee_bash_deal_seventy_five_without_headshots_or_ammo() {
        for faction in [Faction::British, Faction::Russian, Faction::German] {
            let mut sim = arena(2);
            let actor = sim.actor_mut(1).unwrap();
            actor.faction = faction;
            actor.ammo = 0;
            actor.reserve = 0;
            sim.actor_mut(2).unwrap().z = -4.8;
            sim.history.clear();
            sim.record();
            input(
                &mut sim,
                1,
                InputFrame {
                    weapon: Some(WeaponSlot::Grenade),
                    fire: true,
                    melee: true,
                    ..Default::default()
                },
            );
            sim.tick(TICK_SECONDS);
            assert_eq!(sim.actor(2).unwrap().hp, 100, "switching blocks attacks");
            advance(&mut sim, 0.61);
            shoot(&mut sim, 1, 0.0, false);
            assert_eq!(sim.actor(2).unwrap().hp, 25);
            assert!(sim.actor(2).unwrap().alive);
            assert_eq!(sim.actor(1).unwrap().cooldown, MELEE_SECONDS);
            assert_eq!(sim.actor(1).unwrap().last_melee_time, sim.time);
            shoot(&mut sim, 1, 0.0, true);
            assert_eq!(sim.actor(2).unwrap().hp, 25, "both inputs share recovery");
            advance(&mut sim, MELEE_SECONDS);
            shoot(&mut sim, 1, 0.0, true);
            let attacker = sim.actor(1).unwrap();
            assert_eq!(
                (
                    attacker.ammo,
                    attacker.reserve,
                    attacker.shots,
                    attacker.hits
                ),
                (0, 0, 0, 0)
            );
            assert_eq!(attacker.kills, 1);
            assert_eq!(attacker.selected_weapon, WeaponSlot::Grenade);
            assert_eq!(attacker.recoil, 0.0);
            assert_eq!(attacker.last_shot_time, UNSET);
            assert!(!sim.actor(2).unwrap().alive);
            assert!(!sim.actor(2).unwrap().death_headshot);
            let shots: Vec<_> = sim
                .events
                .iter()
                .filter_map(|event| event.shot.as_ref())
                .collect();
            assert_eq!(shots.len(), 2);
            assert!(
                shots
                    .iter()
                    .all(|shot| shot.kind == "melee" && !shot.headshot)
            );
            assert_eq!(
                sim.events
                    .iter()
                    .filter(|event| event.kind == "hurt")
                    .map(|event| event.value)
                    .collect::<Vec<_>>(),
                vec![Some(75.0), Some(75.0)]
            );
            assert_eq!(
                sim.events
                    .iter()
                    .find(|event| event.kind == "kill")
                    .unwrap()
                    .weapon
                    .as_deref(),
                Some("melee")
            );
        }
    }

    #[test]
    fn grenade_bash_is_short_range_and_blocked_by_cover() {
        let mut sim = arena(2);
        sim.actor_mut(1).unwrap().selected_weapon = WeaponSlot::Grenade;
        shoot(&mut sim, 1, 0.0, false);
        assert_eq!(
            sim.actor(2).unwrap().hp,
            100,
            "primary fire never becomes a thrown attack"
        );
        advance(&mut sim, MELEE_SECONDS);
        sim.actor_mut(2).unwrap().z = -4.8;
        sim.actor_mut(2).unwrap().spawn_safe = 1.5;
        sim.history.clear();
        sim.record();
        shoot(&mut sim, 1, 0.0, true);
        assert_eq!(
            sim.actor(2).unwrap().hp,
            100,
            "spawn protection applies to the bash"
        );
        advance(&mut sim, MELEE_SECONDS);
        sim.actor_mut(2).unwrap().spawn_safe = 0.0;
        sim.boxes.push(WorldBox {
            x: 13.6,
            z: -5.4,
            w: 1.0,
            d: 0.2,
            h: 3.0,
        });
        sim.history.clear();
        sim.record();
        shoot(&mut sim, 1, 0.0, false);
        assert_eq!(
            sim.actor(2).unwrap().hp,
            100,
            "a bash cannot pass through cover"
        );
    }

    #[test]
    fn lag_compensation_interpolates_and_is_bounded_to_two_hundred_ms() {
        let mut sim = arena(2);
        // Synthetic historical locations represent valid fixed-step movement;
        // hit queries may rewind, but never mutate the live authoritative actor.
        sim.time = 1.0;
        sim.history.clear();
        sim.actor_mut(2).unwrap().x = 13.6;
        sim.record();
        sim.time = 1.1;
        sim.actor_mut(2).unwrap().x = 14.2;
        sim.record();
        sim.time = 1.2;
        sim.actor_mut(2).unwrap().x = 14.8;
        sim.record();
        let at = sim.rewind_targets(Some(1.05));
        assert!((at.iter().find(|a| a.id == 2).unwrap().x - 13.9).abs() < 1e-9);
        let oldest = sim.rewind_targets(Some(-100.0));
        assert!((oldest.iter().find(|a| a.id == 2).unwrap().x - 13.6).abs() < 1e-9);
        let future = sim.rewind_targets(Some(100.0));
        assert_eq!(future.iter().find(|a| a.id == 2).unwrap().x, 14.8);
        let historical = sim
            .rewind_targets(Some(1.02))
            .into_iter()
            .find(|a| a.id == 2)
            .unwrap();
        let head = sample_hit_volumes(&historical, 1.02)
            .into_iter()
            .find(|v| v.part == HitPart::Head)
            .unwrap()
            .center;
        let eye = sim.actor(1).unwrap().eye();
        let dx = head.x - eye.x;
        let dz = head.z - eye.z;
        input(
            &mut sim,
            1,
            InputFrame {
                yaw: dx.atan2(dz),
                pitch: (head.y - eye.y).atan2(dx.hypot(dz)),
                ads: true,
                fire: true,
                shot_time: Some(1.02),
                ..Default::default()
            },
        );
        sim.tick(TICK_SECONDS);
        assert!(
            !sim.actor(2).unwrap().alive,
            "rewound target should be hit at its displayed position"
        );
        assert_eq!(
            sim.actor(2).unwrap().x,
            14.8,
            "rewind must not move live state"
        );
    }

    #[test]
    fn lag_history_cannot_hit_a_new_life_and_old_requests_cannot_rewind_further() {
        let mut sim = arena(2);
        sim.time = 1.0;
        sim.record();
        sim.spawn(2);
        sim.actor_mut(2).unwrap().spawn_safe = 0.0;
        assert!(sim.rewind_targets(Some(0.9)).iter().all(|a| a.id != 2));
        let mut sim = arena(2);
        sim.time = 1.0;
        sim.record();
        sim.time = 1.1;
        sim.actor_mut(2).unwrap().x = 12.0;
        sim.record();
        sim.time = 1.4;
        sim.record();
        let old = sim.rewind_targets(Some(0.0));
        assert!(old.iter().find(|a| a.id == 2).unwrap().x < 12.1);
    }

    #[test]
    fn match_end_freezes_action_and_restart_preserves_identity_not_scores() {
        let mut sim = arena(2);
        sim.time = ROUND_SECONDS - TICK_SECONDS;
        let now = sim.time;
        {
            let a = sim.actor_mut(1).unwrap();
            a.kills = 4;
            a.moving = 4.8;
            a.pose.as_mut().unwrap().speed = 4.8;
            a.pose.as_mut().unwrap().aim = 1.0;
            a.ads = true;
            a.reload = 1.0;
            a.last_melee_time = now;
        }
        sim.tick(TICK_SECONDS);
        assert!(sim.ended);
        assert_eq!(sim.winner, Some(1));
        assert_eq!(sim.remaining, 0.0);
        for a in &sim.actors {
            assert_eq!(a.moving, 0.0);
            assert_eq!(a.pose.unwrap().speed, 0.0);
            assert_eq!(a.pose.unwrap().aim, 0.0);
            assert_eq!(a.reload, 0.0);
            assert!(!a.ads);
            assert_eq!(a.last_melee_time, UNSET);
        }
        let at = sim.actor(1).unwrap().z;
        input(
            &mut sim,
            1,
            InputFrame {
                forward: 1.0,
                fire: true,
                ..Default::default()
            },
        );
        advance(&mut sim, 8.0);
        assert_eq!(sim.actor(1).unwrap().z, at);
        let now = sim.time;
        sim.restart_round();
        assert_eq!(sim.time, now);
        assert_eq!(sim.round_number, 2);
        assert_eq!(sim.remaining, 300.0);
        assert!(!sim.ended);
        assert_eq!(sim.actor(1).unwrap().name, "Player 1");
        assert_eq!(sim.actor(1).unwrap().kills, 0);
        assert_eq!(
            sim.actor(1).unwrap().ammo + sim.actor(1).unwrap().reserve,
            150
        );
    }

    #[test]
    fn loadout_changes_require_respawn_and_cannot_heal_for_free() {
        let mut sim = arena(1);
        sim.actor_mut(1).unwrap().hp = 25;
        assert!(!sim.change_faction(1, Faction::British));
        assert_eq!(sim.actor(1).unwrap().hp, 25);
        assert!(sim.change_faction(1, Faction::German));
        assert!(!sim.actor(1).unwrap().alive);
        assert_eq!(sim.actor(1).unwrap().deaths, 1);
        assert_eq!(sim.actor(1).unwrap().kills, -1);
        assert!(sim.change_faction(1, Faction::Russian));
        assert_eq!(sim.actor(1).unwrap().deaths, 1);
        advance(&mut sim, 3.1);
        let a = sim.actor(1).unwrap();
        assert!(a.alive);
        assert_eq!(a.faction, Faction::Russian);
        assert_eq!(a.ammo, 5);
        assert_eq!(a.reserve, 145);
    }
}
