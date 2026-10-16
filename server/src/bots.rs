//! Modest server-side opponents for otherwise quiet lobbies. Bots submit the
//! same input frames as humans; they have no alternate damage or movement path.
//! Perception is sampled at 5 Hz, aim has correlated error, and every newly
//! acquired opponent incurs a reaction delay. Navigation is bounded floor BFS.
use crate::sim::{Actor, InputFrame, Simulation, Stance, Vec3, WeaponSlot};
use std::{collections::VecDeque, f64::consts::PI};

const STEP: f64 = 0.75;
const WIDTH: usize = 39;
const DEPTH: usize = 45;
const SIGHT_SECONDS: f64 = 0.2;
const MEMORY_SECONDS: f64 = 2.8;

pub(crate) struct Navigation {
    points: Vec<Vec3>,
    edges: Vec<Vec<usize>>,
}
impl Navigation {
    pub(crate) fn new(sim: &Simulation) -> Self {
        let points: Vec<_> = (0..WIDTH * DEPTH)
            .map(|i| Vec3 {
                x: (i % WIDTH) as f64 * STEP - 14.25,
                y: 0.0,
                z: (i / WIDTH) as f64 * STEP - 16.5,
            })
            .collect();
        let valid: Vec<_> = points.iter().map(|p| sim.walkable(p.x, p.z)).collect();
        let mut edges = vec![vec![]; points.len()];
        for i in 0..points.len() {
            if !valid[i] {
                continue;
            }
            for dz in -1_i32..=1 {
                for dx in -1_i32..=1 {
                    if dx == 0 && dz == 0 {
                        continue;
                    }
                    let x = (i % WIDTH) as i32 + dx;
                    let z = (i / WIDTH) as i32 + dz;
                    if !(0..WIDTH as i32).contains(&x) || !(0..DEPTH as i32).contains(&z) {
                        continue;
                    }
                    let j = z as usize * WIDTH + x as usize;
                    if valid[j] && sim.walkable_segment(points[i], points[j]) {
                        edges[i].push(j);
                    }
                }
            }
        }
        Self { points, edges }
    }

    fn closest(&self, p: Vec3) -> usize {
        (0..self.points.len())
            .filter(|&i| !self.edges[i].is_empty())
            .min_by(|&a, &b| distance(self.points[a], p).total_cmp(&distance(self.points[b], p)))
            .expect("arena has navigable floor")
    }

    fn route(&self, from: Vec3, goal: Vec3) -> VecDeque<Vec3> {
        let start = self.closest(from);
        let end = self.closest(goal);
        let mut parents = vec![usize::MAX; self.points.len()];
        let mut queue = VecDeque::from([start]);
        parents[start] = start;
        while let Some(i) = queue.pop_front() {
            if i == end {
                break;
            }
            for &next in &self.edges[i] {
                if parents[next] == usize::MAX {
                    parents[next] = i;
                    queue.push_back(next);
                }
            }
        }
        if parents[end] == usize::MAX {
            return VecDeque::new();
        }
        let mut route = VecDeque::new();
        let mut i = end;
        while i != start {
            route.push_front(self.points[i]);
            i = parents[i];
        }
        route.push_front(self.points[start]);
        route
    }

    fn patrol(&self, random: f64) -> Vec3 {
        let start = (random * self.points.len() as f64) as usize;
        let i = (0..self.points.len())
            .map(|offset| (start + offset) % self.points.len())
            .find(|&i| !self.edges[i].is_empty())
            .unwrap();
        self.points[i]
    }

    fn cover(&self, sim: &Simulation, from: Vec3, enemy: Vec3) -> Option<Vec3> {
        self.points
            .iter()
            .enumerate()
            .filter(|(i, p)| !self.edges[*i].is_empty() && distance(**p, from) < 9.0)
            .filter(|(_, p)| !sim.line_of_sight(enemy, Vec3 { y: 1.05, ..**p }))
            .min_by(|(_, a), (_, b)| distance(**a, from).total_cmp(&distance(**b, from)))
            .map(|(_, p)| *p)
    }
}

#[derive(Clone, Copy)]
struct Observation {
    actor: u32,
    point: Vec3,
    seen: f64,
}

pub(crate) struct BotBrain {
    seed: u32,
    seq: u64,
    round: u64,
    was_alive: bool,
    observation: Option<Observation>,
    next_sight: f64,
    react_at: f64,
    next_fire: f64,
    next_error: f64,
    error_yaw: f64,
    error_pitch: f64,
    next_plan: f64,
    route: VecDeque<Vec3>,
    last_position: Vec3,
    stuck_since: f64,
    crouch: bool,
}
impl BotBrain {
    pub(crate) fn new(seed: u32) -> Self {
        Self {
            seed,
            seq: 0,
            round: 0,
            was_alive: false,
            observation: None,
            next_sight: 0.0,
            react_at: 0.0,
            next_fire: 0.0,
            next_error: 0.0,
            error_yaw: 0.0,
            error_pitch: 0.0,
            next_plan: 0.0,
            route: VecDeque::new(),
            last_position: Vec3::default(),
            stuck_since: 0.0,
            crouch: false,
        }
    }
    fn random(&mut self) -> f64 {
        self.seed = self.seed.wrapping_mul(1664525).wrapping_add(1013904223);
        f64::from(self.seed) / 4294967296.0
    }

    pub(crate) fn input(&mut self, sim: &Simulation, nav: &Navigation, id: u32) -> InputFrame {
        self.seq += 1;
        let Some(actor) = sim.actor(id) else {
            return InputFrame::default();
        };
        let mut input = InputFrame {
            seq: self.seq,
            yaw: actor.yaw,
            pitch: actor.pitch,
            weapon: Some(WeaponSlot::Rifle),
            ..InputFrame::default()
        };
        if self.round != sim.round_number || (!self.was_alive && actor.alive) {
            self.round = sim.round_number;
            self.observation = None;
            self.next_sight = sim.time + 0.25;
            self.next_fire = sim.time + 1.0;
            self.next_plan = sim.time;
            self.route.clear();
            self.last_position = position(actor);
            self.stuck_since = sim.time;
        }
        self.was_alive = actor.alive;
        if !actor.alive || sim.ended {
            return input;
        }
        if sim.time >= self.next_sight {
            self.next_sight = sim.time + SIGHT_SECONDS;
            self.perceive(sim, actor);
        }
        let observation = self
            .observation
            .filter(|o| sim.time - o.seen < MEMORY_SECONDS);
        // A stale observation is useful only as a search destination, never as
        // a firing solution. Wall checks are repeated at the moment of attack.
        let visible = observation.filter(|o| {
            sim.time - o.seen <= SIGHT_SECONDS + 0.04 && sim.line_of_sight(actor.eye(), o.point)
        });
        if sim.time >= self.next_error {
            self.next_error = sim.time + 0.3 + self.random() * 0.35;
            self.error_yaw = (self.random() - 0.5) * 0.055;
            self.error_pitch = (self.random() - 0.5) * 0.04;
        }
        let reloading = actor.reload > 0.0 || actor.ammo == 0;
        input.reload = !reloading && actor.ammo <= 2 && visible.is_none() && actor.reserve > 0;
        if sim.time >= self.next_plan {
            self.next_plan = sim.time + 1.4 + self.random() * 1.4;
            let goal = if let Some(o) = observation {
                if reloading || input.reload || actor.hp <= 40 {
                    nav.cover(sim, position(actor), o.point).unwrap_or(o.point)
                } else if visible.is_some() && distance(position(actor), o.point) < 13.0 {
                    position(actor)
                } else {
                    o.point
                }
            } else {
                nav.patrol(self.random())
            };
            self.route = nav.route(position(actor), goal);
            self.crouch = visible.is_some() && self.random() < 0.6;
        }
        while self
            .route
            .front()
            .is_some_and(|p| distance(*p, position(actor)) < 0.45)
        {
            self.route.pop_front();
        }
        while self.route.len() > 1 && sim.walkable_segment(position(actor), self.route[1]) {
            self.route.pop_front();
        }
        let destination = self.route.front().copied();
        let target_yaw = visible
            .map(|o| (o.point.x - actor.x).atan2(o.point.z - actor.z) + self.error_yaw)
            .or_else(|| destination.map(|p| (p.x - actor.x).atan2(p.z - actor.z)))
            .unwrap_or(actor.yaw);
        input.yaw = turn(actor.yaw, target_yaw, 2.4 * crate::sim::TICK_SECONDS);
        let target_pitch = visible
            .map(|o| {
                ((o.point.y - actor.eye().y) / distance(position(actor), o.point).max(0.1)).atan()
                    + self.error_pitch
            })
            .unwrap_or(0.0);
        input.pitch = turn(actor.pitch, target_pitch, 1.5 * crate::sim::TICK_SECONDS);
        input.ads = visible.is_some() && !reloading && !input.reload;
        input.stance = Some(if self.crouch && visible.is_some() {
            Stance::Crouch
        } else {
            Stance::Stand
        });
        if let Some(p) = destination {
            let length = distance(position(actor), p).max(0.01);
            let (dx, dz) = ((p.x - actor.x) / length, (p.z - actor.z) / length);
            input.forward = (dx * input.yaw.sin() + dz * input.yaw.cos()) * 0.85;
            input.right = (dx * input.yaw.cos() - dz * input.yaw.sin()) * 0.85;
            input.walk = visible.is_some();
            if distance(self.last_position, position(actor)) > 0.3 {
                self.last_position = position(actor);
                self.stuck_since = sim.time;
            } else if sim.time - self.stuck_since > 1.6 {
                self.route = nav.route(position(actor), nav.patrol(self.random()));
                self.next_plan = sim.time + 2.5;
                self.stuck_since = sim.time;
            }
        } else {
            self.stuck_since = sim.time;
            self.last_position = position(actor);
        }
        if let Some(o) = visible {
            let aimed = angle(target_yaw - input.yaw).abs() < 0.04
                && (target_pitch - input.pitch).abs() < 0.04;
            if sim.time >= self.react_at
                && sim.time >= self.next_fire
                && aimed
                && actor.cooldown <= 0.0
                && actor.reload <= 0.0
                && actor.ammo > 0
                && actor.spawn_safe <= 0.0
                && sim.line_of_sight(actor.eye(), o.point)
            {
                input.fire = true;
                self.next_fire = sim.time + 1.45 + self.random() * 0.9;
                // Do not lock error to a target or correct it on a hit/miss.
                self.next_error = sim.time;
            }
        }
        input
    }

    fn perceive(&mut self, sim: &Simulation, actor: &Actor) {
        let seen = sim
            .actors
            .iter()
            .filter(|other| {
                other.id != actor.id && other.alive && !other.spectator && other.spawn_safe <= 0.0
            })
            .filter(|other| distance(position(actor), position(other)) < 35.0)
            .filter(|other| {
                angle((other.x - actor.x).atan2(other.z - actor.z) - actor.yaw).abs() < PI * 0.38
            })
            .filter(|other| sim.line_of_sight(actor.eye(), torso(other)))
            .min_by(|a, b| {
                distance(position(actor), position(a))
                    .total_cmp(&distance(position(actor), position(b)))
            });
        if let Some(other) = seen {
            if !self
                .observation
                .is_some_and(|o| o.actor == other.id && sim.time - o.seen <= SIGHT_SECONDS + 0.04)
            {
                self.react_at = sim.time + 0.55 + self.random() * 0.5;
                self.next_plan = sim.time;
            }
            self.observation = Some(Observation {
                actor: other.id,
                point: torso(other),
                seen: sim.time,
            });
        } else if self
            .observation
            .is_some_and(|o| sim.time - o.seen > MEMORY_SECONDS)
        {
            self.observation = None;
            self.next_plan = sim.time;
        }
    }
}

fn position(a: &Actor) -> Vec3 {
    Vec3 {
        x: a.x,
        y: a.y,
        z: a.z,
    }
}
fn torso(a: &Actor) -> Vec3 {
    Vec3 {
        x: a.x,
        y: a.y + a.eye_height * 0.67,
        z: a.z,
    }
}
fn distance(a: Vec3, b: Vec3) -> f64 {
    (a.x - b.x).hypot(a.z - b.z)
}
fn angle(v: f64) -> f64 {
    (v + PI).rem_euclid(2.0 * PI) - PI
}
fn turn(from: f64, to: f64, max: f64) -> f64 {
    from + angle(to - from).clamp(-max, max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::{Faction, TICK_SECONDS};

    fn encounter() -> (Simulation, Navigation, BotBrain) {
        let mut sim = Simulation::new(42);
        sim.join(1, "Bot".into(), Faction::German).unwrap();
        sim.join(2, "Human".into(), Faction::British).unwrap();
        for (id, z) in [(1, 0.0), (2, 8.0)] {
            let a = sim.actor_mut(id).unwrap();
            a.x = 0.0;
            a.z = z;
            a.yaw = 0.0;
            a.spawn_safe = 0.0;
            a.cooldown = 0.0;
        }
        let nav = Navigation::new(&sim);
        (sim, nav, BotBrain::new(57))
    }

    #[test]
    fn navigation_routes_around_cover_without_cutting_corners() {
        let sim = Simulation::new(1);
        let nav = Navigation::new(&sim);
        let from = Vec3 {
            x: -8.0,
            y: 0.0,
            z: -6.0,
        };
        let to = Vec3 {
            x: -1.0,
            y: 0.0,
            z: -6.0,
        };
        assert!(!sim.walkable_segment(from, to));
        let route = nav.route(from, to);
        assert!(route.len() > 5);
        for pair in route.as_slices().0.windows(2) {
            assert!(sim.walkable_segment(pair[0], pair[1]));
        }
        assert!(route.iter().any(|point| (point.z + 6.0).abs() > 2.0));
        assert!(route.iter().all(|p| sim.walkable(p.x, p.z)));
    }

    #[test]
    fn reaction_is_delayed_aim_is_imperfect_and_attacks_use_normal_simulation() {
        let (mut sim, nav, mut brain) = encounter();
        let mut first_fire = None;
        let mut shots = 0;
        let mut aim_errors = Vec::new();
        for _ in 0..600 {
            let input = brain.input(&sim, &nav, 1);
            if input.fire {
                first_fire.get_or_insert(sim.time);
                shots += 1;
                let victim = sim.actor(2).unwrap();
                let a = sim.actor(1).unwrap();
                aim_errors.push(angle(input.yaw - (victim.x - a.x).atan2(victim.z - a.z)).abs());
                assert!(sim.time >= brain.react_at);
                assert!(sim.line_of_sight(a.eye(), torso(victim)));
            }
            assert!(sim.submit_input(1, input));
            sim.tick(TICK_SECONDS);
        }
        assert!(first_fire.is_some_and(|time| (0.8..2.0).contains(&time)));
        assert!(
            (2..=7).contains(&shots),
            "deliberate pauses between bolt-action shots: {shots}"
        );
        assert!(aim_errors.iter().any(|&error| error > 0.005));
        assert!(
            sim.actor(1).unwrap().hits > 0,
            "ordinary authoritative combat can hit"
        );
        assert_eq!(sim.actor(1).unwrap().shots, shots);
    }

    #[test]
    fn cover_and_field_of_view_prevent_target_acquisition() {
        let (mut sim, nav, mut brain) = encounter();
        sim.actor_mut(1).unwrap().yaw = PI;
        // Hold position for perception to isolate sight from patrol motion.
        for _ in 0..90 {
            let input = brain.input(&sim, &nav, 1);
            assert!(!input.fire);
            assert!(brain.observation.is_none());
            sim.time += TICK_SECONDS;
        }
        sim.actor_mut(1).unwrap().x = -8.0;
        sim.actor_mut(1).unwrap().z = -6.0;
        sim.actor_mut(1).unwrap().yaw = PI / 2.0;
        sim.actor_mut(2).unwrap().x = -1.0;
        sim.actor_mut(2).unwrap().z = -6.0;
        assert!(!sim.line_of_sight(sim.actor(1).unwrap().eye(), torso(sim.actor(2).unwrap())));
        for _ in 0..120 {
            assert!(!brain.input(&sim, &nav, 1).fire);
            assert!(brain.observation.is_none());
            sim.time += TICK_SECONDS;
        }
    }

    #[test]
    fn empty_rifle_reloads_and_round_restart_reacquires_instead_of_snap_firing() {
        let (mut sim, nav, mut brain) = encounter();
        sim.actor_mut(1).unwrap().ammo = 0;
        for _ in 0..170 {
            let input = brain.input(&sim, &nav, 1);
            sim.submit_input(1, input);
            sim.tick(TICK_SECONDS);
        }
        assert!(sim.actor(1).unwrap().ammo > 0);
        let seq = brain.seq;
        sim.restart_round();
        let input = brain.input(&sim, &nav, 1);
        assert!(!input.fire);
        assert!(brain.observation.is_none());
        assert!(input.seq > seq, "restart never replays old inputs");
        assert_eq!(brain.round, sim.round_number);
    }
}
