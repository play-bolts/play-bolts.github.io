//! CPU mirror of the rendered source-soldier arm solver. Physical segment
//! lengths, palm contacts and the elbow branch are shared with the client.
use crate::hitboxes::{
    Motion, Transform, add, axis, dot, ease, inverse, mix_number, qfromeuler, qmultiply,
    qnormalize, qslerp, rotate, scale, sub, vec,
};
use crate::sim::{Actor, Faction, Vec3, WeaponSlot};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::OnceLock;

type Q = [f64; 4];
const DOWN: Vec3 = Vec3 {
    x: 0.0,
    y: -1.0,
    z: 0.0,
};
fn length(v: Vec3) -> f64 {
    dot(v, v).sqrt()
}
fn normalized(v: Vec3) -> Vec3 {
    let n = length(v);
    if n > 0.0 { scale(v, 1.0 / n) } else { v }
}
fn cross(a: Vec3, b: Vec3) -> Vec3 {
    Vec3 {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
    }
}
fn between(from: Vec3, to: Vec3) -> Q {
    let r = dot(from, to) + 1.0;
    if r < 1e-8 {
        qnormalize(if from.x.abs() > from.z.abs() {
            [-from.y, from.x, 0.0, 0.0]
        } else {
            [0.0, -from.z, from.y, 0.0]
        })
    } else {
        let c = cross(from, to);
        qnormalize([c.x, c.y, c.z, r])
    }
}

#[derive(Clone, Copy, Debug)]
struct ArmGrip {
    middle: Vec3,
    wrist: Vec3,
    rotation: Q,
    error: Vec3,
    #[cfg(test)]
    palm: Vec3,
}

fn two_bone(origin: Vec3, target: Vec3, hint: Vec3, upper: f64, lower: f64) -> (Vec3, Vec3) {
    let delta = sub(target, origin);
    let raw_distance = length(delta);
    let direction = if raw_distance < 1e-8 {
        DOWN
    } else {
        scale(delta, 1.0 / raw_distance)
    };
    let distance = raw_distance.clamp((upper - lower).abs() + 0.00001, upper + lower - 0.00001);
    let reach = add(origin, scale(direction, distance));
    let hint = sub(hint, origin);
    let mut pole = sub(hint, scale(direction, dot(hint, direction)));
    if dot(pole, pole) < 1e-8 {
        pole = cross(
            direction,
            if direction.x.abs() < 0.8 {
                Vec3 {
                    x: 1.0,
                    y: 0.0,
                    z: 0.0,
                }
            } else {
                Vec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 1.0,
                }
            },
        );
    }
    pole = normalized(pole);
    let along = (upper * upper - lower * lower + distance * distance) / (2.0 * distance);
    let height = (upper * upper - along * along).max(0.0).sqrt();
    (
        add(add(origin, scale(direction, along)), scale(pole, height)),
        reach,
    )
}

#[allow(clippy::too_many_arguments)]
fn solve_grip(
    origin: Vec3,
    contact: Vec3,
    offset: Vec3,
    desired: Q,
    hint: Vec3,
    upper: f64,
    lower: f64,
    outward: Vec3,
    limits: Option<(f64, f64)>,
) -> ArmGrip {
    let composite = add(scale(DOWN, lower), offset);
    let composite_length = length(composite);
    let mut target = contact;
    if limits.is_some() {
        target.z = target.z.max(origin.z + 0.12);
    }
    let reach = sub(target, origin);
    let distance = length(reach);
    let minimum = (upper * upper
        + composite_length * composite_length
        + 2.0 * upper * composite_length * (145.0_f64.to_radians()).cos())
    .sqrt();
    if distance < minimum || distance > upper + composite_length - 0.004 {
        let reach = if distance < 1e-7 {
            outward
        } else {
            scale(reach, 1.0 / distance)
        };
        target = add(
            origin,
            scale(
                reach,
                distance.clamp(minimum, upper + composite_length - 0.004),
            ),
        );
    }
    let (mut middle, end) = two_bone(origin, target, hint, upper, composite_length);
    let direction = normalized(sub(end, origin));
    let center = add(
        origin,
        scale(direction, dot(sub(middle, origin), direction)),
    );
    let radius = length(sub(middle, center));
    let mut pole = normalized(sub(middle, center));
    if let Some((floor, ceiling)) = limits {
        if radius > 1e-7 {
            let outside = normalized(sub(outward, scale(direction, dot(outward, direction))));
            let mut down = normalized(cross(direction, outside));
            if down.y > 0.0 {
                down = scale(down, -1.0);
            }
            let side_distance = dot(sub(center, origin), outward);
            let side_radius = radius * dot(outside, outward);
            let maximum = ((0.015 - side_distance) / side_radius.max(1e-7))
                .clamp(-1.0, 1.0)
                .acos()
                .min(1.45);
            let lower_limit = (down.y.atan2(outside.y) + std::f64::consts::PI - 0.10)
                .min(maximum)
                .max(0.0);
            let preference = (origin.y - hint.y)
                .atan2(0.15 + (hint.x - origin.x).abs())
                .clamp(-0.8, 1.35);
            let px = preference.cos();
            let py = preference.sin();
            let mut angle = preference.clamp(-maximum, lower_limit);
            for _ in 0..32 {
                let c = angle.cos();
                let s = angle.sin();
                let y = center.y + radius * (outside.y * c + down.y * s);
                let dy = radius * (-outside.y * s + down.y * c);
                let low = (y - floor).min(0.0);
                let high = (y - ceiling).max(0.0);
                angle = (angle
                    - (px * s - py * c + 8000.0 * (low + high) * dy) * 0.6
                        / (1.0 + 8000.0 * radius * radius))
                    .clamp(-maximum, lower_limit);
            }
            pole = add(scale(outside, angle.cos()), scale(down, angle.sin()));
        }
    }
    middle = add(center, scale(pole, radius));
    let desired_axis = rotate(normalized(composite), desired);
    let actual_axis = normalized(sub(end, middle));
    let swing = between(desired_axis, actual_axis);
    let rotation = qmultiply(swing, desired);
    let wrist = add(middle, scale(rotate(DOWN, rotation), lower));
    let palm = add(wrist, rotate(offset, rotation));
    ArmGrip {
        middle,
        wrist,
        rotation,
        error: sub(palm, contact),
        #[cfg(test)]
        palm,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContactNode {
    parent: isize,
    name: String,
    position: [f64; 3],
    rotation: Q,
    scale: [f64; 3],
    stock_thumb_axis: Option<[f64; 3]>,
    support_thumb_axis: Option<[f64; 3]>,
}
#[derive(Deserialize)]
struct ContactInfluence {
    node: usize,
    point: [f64; 3],
    weight: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContactData {
    normal: [f64; 3],
    stock_grip: bool,
    nodes: Vec<ContactNode>,
    palm: Vec<ContactInfluence>,
    thumb: Option<Vec<ContactInfluence>>,
}
fn hands() -> &'static BTreeMap<String, ContactData> {
    static DATA: OnceLock<BTreeMap<String, ContactData>> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/generated/handCollisionData.json"))
            .expect("validated source hand contact FK")
    })
}
#[derive(Clone, Copy)]
struct Affine {
    columns: [Vec3; 3],
    position: Vec3,
}
impl Affine {
    fn linear(self, p: Vec3) -> Vec3 {
        add(
            add(scale(self.columns[0], p.x), scale(self.columns[1], p.y)),
            scale(self.columns[2], p.z),
        )
    }
    fn point(self, p: Vec3) -> Vec3 {
        add(self.position, self.linear(p))
    }
    fn compose(p: Vec3, q: Q, s: Vec3) -> Self {
        Self {
            position: p,
            columns: [
                rotate(
                    Vec3 {
                        x: s.x,
                        y: 0.0,
                        z: 0.0,
                    },
                    q,
                ),
                rotate(
                    Vec3 {
                        x: 0.0,
                        y: s.y,
                        z: 0.0,
                    },
                    q,
                ),
                rotate(
                    Vec3 {
                        x: 0.0,
                        y: 0.0,
                        z: s.z,
                    },
                    q,
                ),
            ],
        }
    }
    fn multiply(self, b: Self) -> Self {
        Self {
            position: self.point(b.position),
            columns: b.columns.map(|v| self.linear(v)),
        }
    }
}
fn arbitrary_axis(v: Vec3, angle: f64) -> Q {
    let s = (angle / 2.0).sin();
    [v.x * s, v.y * s, v.z * s, (angle / 2.0).cos()]
}
fn hand_contact(left: bool, weapon: Control, slot: WeaponSlot) -> (Vec3, Vec3) {
    let data = &hands()[if left { "left" } else { "right" }];
    let cylinder = slot == WeaponSlot::Grenade && !left;
    let open = if slot == WeaponSlot::Grenade && left {
        0.55
    } else if !left {
        weapon.finger_open
    } else {
        0.0
    }
    .clamp(0.0, 1.0);
    let press = if left { 0.0 } else { weapon.thumb_contact };
    let grasp = if left { 0.0 } else { weapon.bolt_grip };
    let stock_weight = if data.stock_grip && !cylinder {
        (1.0 - press) * (1.0 - grasp)
    } else {
        0.0
    };
    let mut matrices: Vec<Affine> = Vec::with_capacity(data.nodes.len());
    for node in &data.nodes {
        let mut rotation = node.rotation;
        let name = &node.name;
        let segment = if name.contains("01") {
            0
        } else if name.contains("02") {
            1
        } else {
            2
        };
        if name.starts_with('f') {
            let index = name.starts_with("findex");
            let mut base = (if left {
                [0.54, 0.85, 0.7]
            } else if index && !cylinder {
                [0.30, 0.5, 0.38]
            } else {
                [0.72, 1.02, 0.75]
            })[segment];
            if !left && index && !cylinder {
                base = mix_number(base, [0.72, 1.02, 0.75][segment], grasp);
            }
            if stock_weight > 0.0 {
                let stock = if index {
                    [0.30, 0.50, 0.38]
                } else if name.starts_with("fpinky") {
                    [0.15, 0.30, 0.20]
                } else if name.starts_with("fring") {
                    [0.50, 0.50, 0.30]
                } else {
                    [0.65, 0.52, 0.38]
                };
                base = mix_number(base, stock[segment], stock_weight);
            }
            rotation = qmultiply(
                rotation,
                axis(
                    0,
                    mix_number(
                        base * (1.0 - open * 0.85),
                        [0.90, 1.35, 0.95][segment],
                        press,
                    ),
                ),
            );
        } else if name.starts_with("thumb") {
            let curl = [0.18, 0.32, 0.38][segment];
            rotation = qmultiply(
                rotation,
                axis(
                    0,
                    mix_number(
                        curl * (1.0 - open * 0.65),
                        [-0.15, 0.08, 0.12][segment],
                        press,
                    ),
                ),
            );
            if let Some(a) = node.support_thumb_axis {
                rotation = qmultiply(rotation, arbitrary_axis(vec(a), 0.30));
            }
            if let Some(a) = node.stock_thumb_axis {
                rotation = qmultiply(rotation, arbitrary_axis(vec(a), -1.5 * stock_weight));
            }
        }
        let local = Affine::compose(vec(node.position), rotation, vec(node.scale));
        matrices.push(if node.parent < 0 {
            local
        } else {
            matrices[node.parent as usize].multiply(local)
        });
    }
    let point = |influences: &[ContactInfluence]| {
        influences.iter().fold(
            Vec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
            |sum, item| {
                add(
                    sum,
                    scale(matrices[item.node].point(vec(item.point)), item.weight),
                )
            },
        )
    };
    let mut contact = point(&data.palm);
    if press > 0.0 {
        if let Some(thumb) = &data.thumb {
            contact = add(contact, scale(sub(point(thumb), contact), press));
        }
    }
    (vec(data.normal), contact)
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Control {
    position: [f64; 3],
    rotation: [f64; 3],
    right: [f64; 3],
    finger_open: f64,
    thumb_contact: f64,
    bolt_grip: f64,
}
#[derive(Deserialize)]
struct ControlTable {
    phases: Vec<f64>,
    frames: Vec<Control>,
}
#[derive(Deserialize)]
struct RifleTransform {
    position: [f64; 3],
    rotation: Q,
    scale: [f64; 3],
}
#[derive(Deserialize)]
struct Contacts {
    left: [f64; 3],
    right: [f64; 3],
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArmRig {
    bone_positions: BTreeMap<String, [f64; 3]>,
    rifle: RifleTransform,
    stock_contacts: Contacts,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArmData {
    rigs: BTreeMap<String, ArmRig>,
    weapon_controls: BTreeMap<String, BTreeMap<String, ControlTable>>,
}
fn arm_data() -> &'static ArmData {
    static DATA: OnceLock<ArmData> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/generated/hitboxData.json"))
            .expect("validated source weapon controls and bind rig")
    })
}
fn controls(faction: &str, mode: &str, phase: f64) -> Control {
    let table = &arm_data().weapon_controls[faction][mode];
    let t = phase.clamp(0.0, 1.0);
    let next = table
        .phases
        .partition_point(|p| *p < t)
        .min(table.phases.len() - 1);
    let previous = next.saturating_sub(1);
    let w = if next == previous {
        0.0
    } else {
        (t - table.phases[previous]) / (table.phases[next] - table.phases[previous])
    };
    let a = table.frames[previous];
    let b = table.frames[next];
    let triples = |a: [f64; 3], b: [f64; 3]| std::array::from_fn(|i| mix_number(a[i], b[i], w));
    Control {
        position: triples(a.position, b.position),
        rotation: triples(a.rotation, b.rotation),
        right: triples(a.right, b.right),
        finger_open: mix_number(a.finger_open, b.finger_open, w),
        thumb_contact: mix_number(a.thumb_contact, b.thumb_contact, w),
        bolt_grip: mix_number(a.bolt_grip, b.bolt_grip, w),
    }
}
fn keys(t: f64, values: &[(f64, [f64; 3])]) -> Vec3 {
    if t <= values[0].0 {
        return vec(values[0].1);
    }
    for i in 1..values.len() {
        if t <= values[i].0 {
            return add(
                vec(values[i - 1].1),
                scale(
                    sub(vec(values[i].1), vec(values[i - 1].1)),
                    ease((t - values[i - 1].0) / (values[i].0 - values[i - 1].0)),
                ),
            );
        }
    }
    vec(values[values.len() - 1].1)
}
fn basis(x: Vec3, y: Vec3, z: Vec3) -> Q {
    let trace = x.x + y.y + z.z;
    if trace > 0.0 {
        let s = 0.5 / (trace + 1.0).sqrt();
        [(y.z - z.y) * s, (z.x - x.z) * s, (x.y - y.x) * s, 0.25 / s]
    } else if x.x > y.y && x.x > z.z {
        let s = 2.0 * (1.0 + x.x - y.y - z.z).sqrt();
        [0.25 * s, (y.x + x.y) / s, (z.x + x.z) / s, (y.z - z.y) / s]
    } else if y.y > z.z {
        let s = 2.0 * (1.0 + y.y - x.x - z.z).sqrt();
        [(y.x + x.y) / s, 0.25 * s, (z.y + y.z) / s, (z.x - x.z) / s]
    } else {
        let s = 2.0 * (1.0 + z.z - x.x - y.y).sqrt();
        [(z.x + x.z) / s, (z.y + y.z) / s, 0.25 * s, (x.y - y.x) / s]
    }
}
fn palm_frame(normal: Vec3, fingers: Vec3) -> Q {
    let x = normalized(normal);
    let y = normalized(sub(fingers, scale(x, dot(fingers, x))));
    basis(x, y, cross(x, y))
}
fn hand_rotation(
    left: bool,
    weapon: Control,
    normal: Vec3,
    orientation: Q,
    relaxed: Q,
    slot: WeaponSlot,
) -> Q {
    if slot == WeaponSlot::Grenade && left {
        return relaxed;
    }
    let source = inverse(palm_frame(normal, DOWN));
    if slot == WeaponSlot::Grenade {
        return qmultiply(
            qmultiply(
                orientation,
                palm_frame(vec([1.0, 0.0, 0.0]), vec([0.0, -0.10, 1.0])),
            ),
            source,
        );
    }
    let fingers = vec([if left { -0.8 } else { 0.8 }, 0.0, 0.6]);
    let mut desired = palm_frame(vec([0.0, 1.0, 0.0]), fingers);
    if !left {
        desired = qslerp(
            desired,
            palm_frame(vec([1.0, 0.2, 0.0]), vec([0.0, -0.35, 1.0])),
            weapon.bolt_grip,
        );
        desired = qslerp(
            desired,
            palm_frame(vec([0.0, -1.0, 0.0]), fingers),
            weapon.thumb_contact,
        );
    }
    qmultiply(qmultiply(orientation, desired), source)
}

/// Exact body-relative target/IK layer. Only the authored scalar weapon
/// controls use a dense, separately validated interpolation table.
pub(crate) fn sample_arms(
    actor: &Actor,
    time: f64,
    core: &[Transform; 15],
    state: Motion,
) -> [Transform; 6] {
    let faction = match actor.faction {
        Faction::British => "british",
        Faction::Russian => "russian",
        Faction::German => "german",
    };
    let rig = &arm_data().rigs[faction];
    let cycle = match actor.faction {
        Faction::British => 1.08,
        Faction::Russian => 1.18,
        Faction::German => 1.12,
    };
    let melee = time - actor.last_melee_time;
    let shot = time - actor.last_shot_time;
    let (mode, progress) = if (0.0..0.85 / 1.2).contains(&melee) {
        ("melee", melee / (0.85 / 1.2))
    } else if actor.reload > 0.0 {
        (
            if actor.faction == Faction::British && actor.reload_total <= 3.25 * 0.8 {
                "reloadPartial"
            } else {
                "reload"
            },
            1.0 - actor.reload / actor.reload_total.max(0.01),
        )
    } else if (0.0..cycle).contains(&shot) {
        ("cycle", shot / cycle)
    } else {
        ("idle", 0.0)
    };
    let mut weapon = controls(faction, mode, progress);
    let manipulation = weapon
        .bolt_grip
        .max(weapon.thumb_contact)
        .max(weapon.finger_open);
    let held_pitch = actor.pitch * (1.0 - manipulation * 0.75);
    let held_aim = state.aim * (1.0 - manipulation * 0.75);
    let variation = if actor.pose.is_some() {
        0.0
    } else {
        actor.id as f64
    };
    let breathe = (time * 1.85 + variation).sin() * 0.0023;
    let age = time - actor.last_hurt_time;
    let hurt = if (0.0..0.42).contains(&age) {
        (age / 0.42 * std::f64::consts::PI).sin() * (-age * 3.0).exp()
    } else {
        0.0
    };
    let neck = core[2].position;
    let spine = core[1];
    let prone = state.prone;
    let mut position = Vec3 {
        x: neck.x - 0.085 - weapon.position[0] * 0.65,
        y: neck.y
            + mix_number(
                mix_number(-0.175, 0.04, held_aim) - manipulation * 0.07,
                0.11 - manipulation * 0.035,
                prone,
            )
            + breathe
            + weapon.position[1] * 0.65
            - hurt * 0.025,
        z: neck.z + mix_number(mix_number(0.115, 0.025, held_aim), 0.025, prone)
            - weapon.position[2] * 0.65,
    };
    let rotation_scale = if mode == "melee" && actor.selected_weapon == WeaponSlot::Rifle {
        1.0
    } else {
        0.7
    };
    let mut rotation = [
        -held_pitch - actor.recoil.min(0.09) - weapon.rotation[0] * rotation_scale,
        weapon.rotation[1] * rotation_scale,
        -weapon.rotation[2] * rotation_scale,
    ];
    let left_hint = Vec3 {
        x: neck.x + 0.34,
        y: neck.y + mix_number(-0.47, -0.10, prone),
        z: neck.z + mix_number(0.20, 0.15, prone),
    };
    let mut right_hint = Vec3 {
        x: neck.x - 0.36,
        y: neck.y + mix_number(-0.42, -0.10, prone),
        z: neck.z + mix_number(0.07, 0.03, prone),
    };
    let age = time - actor.switch_started;
    let switching = age >= 0.0 && age < actor.switch_duration;
    let switch_t = if switching {
        age / actor.switch_duration
    } else {
        1.0
    };
    let switch_position = keys(
        switch_t,
        &[
            (0.0, [0.0, 0.0, 0.0]),
            (0.12, [0.0, 0.0, 0.0]),
            (0.40, [0.025, -0.25, 0.272]),
            (0.57, [0.025, -0.25, 0.272]),
            (0.91, [0.0, 0.008, -0.006]),
            (1.0, [0.0, 0.0, 0.0]),
        ],
    );
    let switch_rotation = keys(
        switch_t,
        &[
            (0.0, [0.0, 0.0, 0.0]),
            (0.12, [0.0, 0.0, 0.0]),
            (0.40, [-0.07, 0.06, 0.04]),
            (0.57, [-0.07, 0.06, 0.04]),
            (0.91, [0.012, 0.0, -0.004]),
            (1.0, [0.0, 0.0, 0.0]),
        ],
    );
    let slot = if switching && switch_t < 0.5 {
        actor.switch_from
    } else {
        actor.selected_weapon
    };
    if switching {
        position.y += switch_position.y * 0.65;
        position.z -= switch_position.z * 0.35;
        rotation[0] -= switch_rotation.x * 0.5;
    }
    let mut left_target = None;
    let mut right_target = None;
    let mut grenade_rotation = [0.0; 3];
    if slot == WeaponSlot::Grenade {
        let mut right = Vec3 {
            x: neck.x - 0.25,
            y: neck.y + mix_number(-0.36, 0.05, prone) + switch_position.y * 0.5,
            z: neck.z + mix_number(0.22, 0.10, prone),
        };
        left_target = Some(Vec3 {
            x: neck.x + 0.25,
            y: neck.y + mix_number(-0.60, -0.11, prone) + switch_position.y * 0.3,
            z: neck.z + mix_number(0.14, -0.03, prone),
        });
        right_hint = Vec3 {
            x: neck.x - 0.39,
            y: neck.y + mix_number(-0.34, -0.07, prone),
            z: neck.z + mix_number(0.02, -0.07, prone),
        };
        weapon = controls(faction, "idle", 0.0);
        if mode == "melee" && !switching {
            let p = keys(
                progress,
                &[
                    (0.0, [0.0, 0.0, 0.0]),
                    (0.18, [-0.025, 0.32, 0.055]),
                    (0.34, [-0.045, -0.13, -0.24]),
                    (0.44, [-0.04, -0.16, -0.20]),
                    (1.0, [0.0, 0.0, 0.0]),
                ],
            );
            let q = keys(
                progress,
                &[
                    (0.0, [0.0, 0.0, 0.0]),
                    (0.18, [0.58, 0.0, 0.04]),
                    (0.34, [-1.25, 0.0, -0.025]),
                    (0.44, [-1.13, 0.0, -0.02]),
                    (1.0, [0.0, 0.0, 0.0]),
                ],
            );
            right.x -= p.x;
            right.y += p.y;
            right.z -= p.z;
            grenade_rotation = [-q.x, -q.y, q.z];
            right_hint.y += p.y.max(0.0) * 0.55;
        }
        right_target = Some(right);
    }
    position.x += 0.03;
    position.z -= 0.055;
    let rifle_q = qfromeuler(rotation);
    let orientation = if slot == WeaponSlot::Grenade {
        qfromeuler(grenade_rotation)
    } else {
        rifle_q
    };
    let right_source = add(
        vec(weapon.right),
        scale(
            sub(vec(rig.stock_contacts.right), vec(weapon.right)),
            1.0 - weapon
                .bolt_grip
                .max(weapon.thumb_contact)
                .max(weapon.finger_open),
        ),
    );
    let sources = [vec(rig.stock_contacts.left), right_source];
    let hints = [left_hint, right_hint];
    let indices = [6usize, 3usize];
    let names = [
        ["upperArmR", "lowerArmR", "handR"],
        ["upperArmL", "lowerArmL", "handL"],
    ];
    let shoulders = names.map(|n| {
        add(
            spine.position,
            rotate(
                sub(
                    vec(rig.bone_positions[n[0]]),
                    vec(rig.bone_positions["spine"]),
                ),
                spine.rotation,
            ),
        )
    });
    let lengths = names.map(|n| {
        [
            length(sub(
                vec(rig.bone_positions[n[1]]),
                vec(rig.bone_positions[n[0]]),
            )),
            length(sub(
                vec(rig.bone_positions[n[2]]),
                vec(rig.bone_positions[n[1]]),
            )),
        ]
    });
    let contacts = [
        hand_contact(true, weapon, slot),
        hand_contact(false, weapon, slot),
    ];
    let desired = [
        hand_rotation(
            true,
            weapon,
            contacts[0].0,
            orientation,
            spine.rotation,
            slot,
        ),
        hand_rotation(
            false,
            weapon,
            contacts[1].0,
            orientation,
            spine.rotation,
            slot,
        ),
    ];
    let fit = |side: usize, target: Vec3| {
        let mut hint = hints[side];
        hint.z -= 0.25;
        solve_grip(
            shoulders[side],
            target,
            contacts[side].1,
            desired[side],
            hint,
            lengths[side][0],
            lengths[side][1],
            vec([if side == 0 { 1.0 } else { -1.0 }, 0.0, 0.0]),
            Some((
                0.11,
                if slot == WeaponSlot::Rifle {
                    shoulders[side].y - 0.025
                } else {
                    f64::INFINITY
                },
            )),
        )
    };
    let rifle_local = Affine::compose(
        vec(rig.rifle.position),
        rig.rifle.rotation,
        vec(rig.rifle.scale),
    );
    let local_points = sources.map(|p| rotate(rifle_local.point(p), rifle_q));
    if slot == WeaponSlot::Rifle {
        for _ in 0..20 {
            let left = fit(0, add(position, local_points[0]));
            let right = fit(1, add(position, local_points[1]));
            let left_error = length(left.error);
            let right_error = length(right.error);
            if left_error.max(right_error) < 0.00005 {
                break;
            }
            let mut correction = if left_error > right_error {
                left.error
            } else {
                right.error
            };
            let size = length(correction);
            if size > 0.045 {
                correction = scale(correction, 0.045 / size);
            }
            position = add(position, correction);
        }
    }
    let targets = [
        left_target.unwrap_or_else(|| add(position, local_points[0])),
        right_target.unwrap_or_else(|| add(position, local_points[1])),
    ];
    let mut result = [core[3]; 6];
    for side in 0..2 {
        let solved = fit(side, targets[side]);
        let parent_inverse = inverse(spine.rotation);
        let upper = between(
            DOWN,
            normalized(rotate(sub(solved.middle, shoulders[side]), parent_inverse)),
        );
        let hand_in_parent = qmultiply(parent_inverse, solved.rotation);
        let forearm = normalized(rotate(sub(solved.wrist, solved.middle), parent_inverse));
        let lower = qmultiply(
            between(rotate(DOWN, hand_in_parent), forearm),
            hand_in_parent,
        );
        let start = indices[side] - 3;
        result[start] = Transform {
            position: shoulders[side],
            rotation: qmultiply(spine.rotation, upper),
        };
        result[start + 1] = Transform {
            position: solved.middle,
            rotation: qmultiply(spine.rotation, lower),
        };
        result[start + 2] = Transform {
            position: solved.wrist,
            rotation: qmultiply(
                spine.rotation,
                qmultiply(lower, qmultiply(inverse(lower), hand_in_parent)),
            ),
        };
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn v(a: [f64; 3]) -> Vec3 {
        Vec3 {
            x: a[0],
            y: a[1],
            z: a[2],
        }
    }
    fn close(a: Vec3, b: [f64; 3]) {
        assert!(length(sub(a, v(b))) < 1e-11, "actual {a:?}, expected {b:?}");
    }
    #[test]
    fn selected_skin_contact_fk_matches_actual_hand_geometry() {
        let values = [
            (
                true,
                WeaponSlot::Rifle,
                [0.0, 0.0, 0.0],
                [
                    -0.0341595943704889,
                    -0.11901473614171705,
                    0.004392901670133337,
                ],
            ),
            (
                true,
                WeaponSlot::Grenade,
                [0.6, 0.35, 0.48],
                [
                    -0.03515349434866215,
                    -0.1496796412519904,
                    0.008479259666494134,
                ],
            ),
            (
                false,
                WeaponSlot::Rifle,
                [0.0, 0.0, 0.0],
                [
                    0.003912663207256393,
                    -0.10356325713111937,
                    0.004705496469204674,
                ],
            ),
            (
                false,
                WeaponSlot::Rifle,
                [0.6, 0.35, 0.48],
                [
                    0.028029037467796655,
                    -0.096773750732302,
                    0.017045374238963643,
                ],
            ),
            (
                false,
                WeaponSlot::Grenade,
                [0.0, 0.0, 0.0],
                [
                    0.0034748384183385253,
                    -0.10335601375604658,
                    0.004832696070711989,
                ],
            ),
            (
                false,
                WeaponSlot::Grenade,
                [0.6, 0.35, 0.48],
                [
                    0.01962053271330115,
                    -0.10822940733392979,
                    0.01712900440504202,
                ],
            ),
        ];
        for (left, slot, weights, expected) in values {
            let weapon = Control {
                position: [0.0; 3],
                rotation: [0.0; 3],
                right: [0.0; 3],
                finger_open: weights[0],
                thumb_contact: weights[1],
                bolt_grip: weights[2],
            };
            close(hand_contact(left, weapon, slot).1, expected);
        }
    }
    #[derive(Deserialize)]
    struct VolumeFixture {
        name: String,
        actor: Actor,
        time: f64,
        volumes: Vec<crate::hitboxes::HitVolume>,
    }
    #[test]
    fn complete_arm_volumes_match_typescript_for_all_factions_and_actions() {
        let fixtures: Vec<VolumeFixture> =
            serde_json::from_str(include_str!("../../tests/fixtures/hitbox-parity.json")).unwrap();
        let mut count = 0;
        let mut worst = 0.0_f64;
        for fixture in fixtures {
            let actual = crate::hitboxes::sample_hit_volumes(&fixture.actor, fixture.time);
            for (a, b) in actual.iter().zip(fixture.volumes) {
                if !a.name.contains("Arm")
                    && !a.name.starts_with("forearm")
                    && !a.name.starts_with("hand")
                {
                    continue;
                }
                assert_eq!(a.name, b.name);
                let center = length(sub(a.center, b.center));
                let support = (0..80)
                    .map(|i| {
                        let y = 1.0 - 2.0 * (i as f64 + 0.5) / 80.0;
                        let r = (1.0 - y * y).sqrt();
                        let theta = i as f64 * 2.399963229728653;
                        let n = vec([theta.cos() * r, y, theta.sin() * r]);
                        let radius = |q: Q| {
                            let p = rotate(n, inverse(q));
                            length(Vec3 {
                                x: p.x * a.half_size.x,
                                y: p.y * a.half_size.y,
                                z: p.z * a.half_size.z,
                            })
                        };
                        dot(sub(a.center, b.center), n).abs()
                            + (radius(a.rotation) - radius(b.rotation)).abs()
                    })
                    .fold(0.0_f64, f64::max);
                worst = worst.max(support);
                assert!(
                    support < 0.001,
                    "{} {} boundary {support}m, center {center}m, actual {:?}, expected {:?}",
                    fixture.name,
                    a.name,
                    a.center,
                    b.center
                );
                count += 1;
            }
        }
        assert!(count >= 36 * 6);
        eprintln!("{count} complete arm volumes; worst TS/Rust support error {worst:.9}m");
    }
    #[test]
    fn exact_grip_solver_matches_rendered_standing_and_low_stance_fixtures() {
        // Values independently evaluated by the source THREE-based solver,
        // including its constrained elbow gradient iterations and palm fit.
        let first = solve_grip(
            v([-0.18, 1.43, 0.0]),
            v([-0.03, 1.27, 0.32]),
            v([0.018, -0.06, 0.0]),
            [
                -0.04915157902114466,
                0.24247235169095427,
                -0.19249318242027594,
                0.9495986813738215,
            ],
            v([-0.36, 0.99, -0.18]),
            0.31,
            0.285,
            v([-1.0, 0.0, 0.0]),
            Some((0.11, 1.405)),
        );
        close(
            first.middle,
            [-0.2621472577445426, 1.146833646416621, 0.09575303777606506],
        );
        close(
            first.wrist,
            [-0.08178215653972368, 1.251232343918847, 0.2901607079622338],
        );
        close(first.palm, [-0.03, 1.27, 0.32]);
        let second = solve_grip(
            v([0.18, 0.37, 0.35]),
            v([0.05, 0.12, 0.7]),
            v([-0.02, -0.065, 0.008]),
            [
                0.08186638902415327,
                -0.31474001969733423,
                0.1443831675562504,
                0.9345534309366647,
            ],
            v([0.33, 0.25, 0.25]),
            0.31,
            0.285,
            v([1.0, 0.0, 0.0]),
            Some((0.11, 0.345)),
        );
        close(
            second.middle,
            [0.33799375207051274, 0.1510917905533023, 0.5023718154499778],
        );
        close(
            second.wrist,
            [0.11319946153049776, 0.11581095180592688, 0.6739753974577348],
        );
        close(second.palm, [0.05, 0.12, 0.7]);
    }
    #[test]
    fn minimum_reach_keeps_the_rendered_anatomical_branch_and_fixed_lengths() {
        let origin = v([0.18, 1.43, 0.0]);
        let fit = solve_grip(
            origin,
            v([0.21, 1.4, 0.08]),
            v([-0.018, -0.06, 0.0]),
            [
                -0.19253963551247746,
                0.10760083907197164,
                0.02892915190771612,
                0.9749428969727562,
            ],
            v([0.35, 0.9, -0.3]),
            0.31,
            0.285,
            v([1.0, 0.0, 0.0]),
            Some((0.11, 1.405)),
        );
        close(
            fit.middle,
            [0.3441563048262509, 1.1741101846970181, -0.06060618788537141],
        );
        close(
            fit.wrist,
            [0.25921181164845436, 1.3422304815012727, 0.15327461742734633],
        );
        close(
            fit.error,
            [
                0.017136951598479055,
                -0.017136951598478944,
                0.1085478063939161,
            ],
        );
        assert!((length(sub(fit.middle, origin)) - 0.31).abs() < 1e-12);
        assert!((length(sub(fit.wrist, fit.middle)) - 0.285).abs() < 1e-12);
    }
}
