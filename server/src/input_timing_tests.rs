use super::*;

fn arena() -> Simulation {
    let mut sim = Simulation::new(51235);
    sim.join(42, "Timing".into(), Faction::British).unwrap();
    let a = sim.actor_mut(42).unwrap();
    a.x = 13.5;
    a.z = 0.0;
    a.yaw = 0.0;
    a.cooldown = 0.0;
    a.spawn_safe = 0.0;
    sim.drain_events();
    sim
}

fn command(sim: &Simulation, seq: u64, tick: u64, forward: f64) -> InputFrame {
    InputFrame {
        seq,
        tick: Some(tick),
        generation: Some(sim.actor(42).unwrap().spawn_generation),
        forward,
        ..Default::default()
    }
}

#[test]
fn batched_commands_each_own_one_tick_and_stop_is_not_overwritten() {
    let mut sim = arena();
    for (seq, tick, forward) in [(1, 2, 1.0), (2, 3, 1.0), (3, 4, 0.0)] {
        assert!(sim.submit_input(42, command(&sim, seq, tick, forward)));
    }
    for (expected_z, expected_ack) in [(0.0, 0), (0.08, 1), (0.16, 2), (0.16, 3), (0.16, 3)] {
        sim.tick(TICK_SECONDS);
        let a = sim.actor(42).unwrap();
        assert!((a.z - expected_z).abs() < 1e-10);
        assert_eq!(a.ack, expected_ack);
    }
}

#[test]
fn missing_ticks_stop_horizontal_motion_but_keep_gravity_and_timers_running() {
    let mut sim = arena();
    let mut jump = command(&sim, 1, 1, 1.0);
    jump.jump = true;
    jump.fire = true;
    assert!(sim.submit_input(42, jump));
    sim.tick(TICK_SECONDS);
    let first = sim.actor(42).unwrap().clone();
    for _ in 0..10 {
        sim.tick(TICK_SECONDS);
    }
    let a = sim.actor(42).unwrap();
    assert!((a.z - first.z).abs() < 1e-10);
    assert_eq!(a.moving, 0.0);
    assert!(a.y > first.y);
    assert!(a.vy < first.vy);
    assert!(a.cooldown < first.cooldown);
    assert_eq!(a.shots, 1, "an action is never repeated in an empty tick");
    assert_eq!(a.ack, 1);
    assert!(
        !sim.submit_input(42, command(&sim, 2, 3, 1.0)),
        "late input cannot move in a later tick"
    );
}

#[test]
fn scheduling_is_bounded_and_packet_spam_cannot_buy_simulation_time() {
    let mut sim = arena();
    for tick in 1..=MAX_INPUT_LEAD_TICKS {
        assert!(sim.submit_input(42, command(&sim, tick, tick, 1.0)));
    }
    assert!(!sim.submit_input(42, command(&sim, 100, MAX_INPUT_LEAD_TICKS + 1, 1.0)));
    assert!(
        !sim.submit_input(42, command(&sim, 101, 1, 0.0)),
        "a later packet cannot replace a scheduled tick"
    );
    assert!(
        !sim.submit_input(
            42,
            InputFrame {
                seq: 102,
                forward: 1.0,
                ..Default::default()
            }
        ),
        "a scheduled stream cannot switch back to held inputs"
    );
    assert_eq!(sim.controls[&42].queue.len(), MAX_INPUT_LEAD_TICKS as usize);
    assert_eq!(sim.time, 0.0);
    sim.tick(TICK_SECONDS);
    assert!((sim.actor(42).unwrap().z - 0.08).abs() < 1e-10);
    assert_eq!(sim.actor(42).unwrap().ack, 1);
}

#[test]
fn actions_remain_on_their_scheduled_ticks_instead_of_firing_on_arrival() {
    let mut sim = arena();
    let mut fire = command(&sim, 1, 3, 0.0);
    fire.fire = true;
    assert!(sim.submit_input(42, fire));
    assert!(sim.submit_input(42, command(&sim, 2, 4, 0.0)));
    sim.tick(TICK_SECONDS);
    sim.tick(TICK_SECONDS);
    assert_eq!(sim.actor(42).unwrap().shots, 0);
    sim.tick(TICK_SECONDS);
    assert_eq!(sim.actor(42).unwrap().shots, 1);
    let events = sim.drain_events();
    let shot = events.iter().find(|e| e.kind == "shot").unwrap();
    assert_eq!(shot.seq, Some(1));
    sim.tick(TICK_SECONDS);
    assert_eq!(sim.actor(42).unwrap().shots, 1);
}

#[test]
fn new_life_and_reconnect_discard_old_queued_intent() {
    let mut sim = arena();
    let old = command(&sim, 1, 4, 1.0);
    assert!(sim.submit_input(42, old.clone()));
    sim.spawn(42);
    let start = sim.actor(42).unwrap().clone();
    let mut stale = old;
    stale.seq = 2;
    assert!(!sim.submit_input(42, stale));
    assert!(
        sim.submit_input(42, command(&sim, 3, 2, 0.0)),
        "a new life can schedule before the discarded old input horizon"
    );
    for _ in 0..4 {
        sim.tick(TICK_SECONDS);
    }
    assert_eq!(sim.actor(42).unwrap().x, start.x);
    assert_eq!(sim.actor(42).unwrap().z, start.z);
    assert!(sim.submit_input(42, command(&sim, 4, 7, 1.0)));
    sim.reset_input_stream(42);
    assert!(sim.controls[&42].queue.is_empty());
    let next = command(&sim, sim.actor(42).unwrap().ack + 1, 6, 0.0);
    assert!(
        sim.submit_input(42, next),
        "new socket resumes at simulated ack, not the discarded future sequence"
    );
}

#[test]
fn ended_rounds_do_not_accumulate_commands() {
    let mut sim = arena();
    assert!(sim.submit_input(42, command(&sim, 1, 3, 1.0)));
    sim.finish();
    for seq in 2..100 {
        assert!(!sim.submit_input(42, command(&sim, seq, sim.tick_number + 3, 1.0)));
        sim.tick(TICK_SECONDS);
    }
    assert!(sim.controls[&42].queue.is_empty());
}

#[test]
fn scheduling_feedback_counts_unique_late_commands_and_real_gaps() {
    let mut sim = arena();
    assert!(sim.submit_input(42, command(&sim, 1, 3, 1.0)));
    assert_eq!(sim.input_timing(42).arrival_lead, 3);
    for _ in 0..3 { sim.tick(TICK_SECONDS); }
    assert_eq!(sim.input_timing(42).missing, 0, "initial scheduling cushion is not starvation");
    sim.tick(TICK_SECONDS);
    assert_eq!(sim.input_timing(42).missing, 1);
    let late = command(&sim, 2, 4, 1.0);
    assert!(!sim.submit_input(42, late.clone()));
    assert!(!sim.submit_input(42, late));
    let timing = sim.input_timing(42);
    assert_eq!(timing.received, 2);
    assert_eq!(timing.late, 1, "replayed packets cannot inflate feedback");
    assert_eq!(timing.arrival_lead, 0);
    sim.reset_input_stream(42);
    assert_eq!(sim.input_timing(42).received, 0);
    sim.tick(TICK_SECONDS);
    assert_eq!(sim.input_timing(42).missing, 0, "disconnected or reset streams do not accumulate gaps");
}

#[test]
fn shot_diagnostics_report_rewind_clipping_without_extending_the_fairness_window() {
    let mut sim = arena();
    for _ in 0..30 { sim.tick(TICK_SECONDS); }
    let mut fire = command(&sim, 1, 31, 0.0);
    fire.fire = true;
    fire.shot_time = Some(sim.time - 0.25);
    assert!(sim.submit_input(42, fire));
    sim.tick(TICK_SECONDS);
    let timing = sim.input_timing(42);
    assert_eq!(timing.shots, 1);
    assert_eq!(timing.rewind_clamped, 1);
    assert!((timing.shot_age_ms - 266.6666666667).abs() < 0.001);
    assert_eq!(MAX_REWIND, 0.2);
}

#[test]
fn typescript_and_rust_share_movement_traces() {
    fn compare(actual: &serde_json::Value, expected: &serde_json::Value, path: &str) {
        if let Some(number) = expected.as_f64() {
            let value = actual.as_f64().unwrap();
            assert!((value - number).abs() < 1e-8, "{path}: {value} != {number}");
        } else if let Some(fields) = expected.as_object() {
            for (key, value) in fields {
                compare(&actual[key], value, &format!("{path}.{key}"));
            }
        } else {
            assert_eq!(actual, expected, "{path}");
        }
    }
    #[derive(Deserialize)]
    struct Row {
        id: u32,
        input: serde_json::Value,
    }
    #[derive(Deserialize)]
    struct Segment {
        ticks: u32,
        inputs: Vec<Row>,
        expected: Vec<serde_json::Value>,
    }
    #[derive(Deserialize)]
    struct Fixture {
        name: String,
        actors: Vec<Actor>,
        segments: Vec<Segment>,
    }
    let fixtures: Vec<Fixture> =
        serde_json::from_str(include_str!("../../tests/fixtures/movement-parity.json")).unwrap();
    for fixture in fixtures {
        let mut sim = Simulation::new(51235);
        for actor in fixture.actors {
            let id = actor.id;
            sim.join(id, actor.name.clone(), actor.faction).unwrap();
            *sim.actor_mut(id).unwrap() = actor;
        }
        let mut seq = 0;
        for segment in fixture.segments {
            for _ in 0..segment.ticks {
                seq += 1;
                let ids: Vec<_> = sim.actors.iter().map(|a| a.id).collect();
                for id in ids {
                    let row = segment.inputs.iter().find(|row| row.id == id);
                    let mut input: InputFrame = row.map_or_else(InputFrame::default, |row| {
                        serde_json::from_value(row.input.clone()).unwrap()
                    });
                    input.seq = seq;
                    // A segment without a turn keeps the actor's orientation.
                    if row.is_none_or(|row| row.input.get("yaw").is_none()) {
                        input.yaw = sim.actor(id).unwrap().yaw;
                    }
                    if row.is_none_or(|row| row.input.get("pitch").is_none()) {
                        input.pitch = sim.actor(id).unwrap().pitch;
                    }
                    assert!(sim.submit_input(id, input));
                }
                sim.tick(TICK_SECONDS);
            }
            for expected in segment.expected {
                let actor = sim.actor(expected["id"].as_u64().unwrap() as u32).unwrap();
                let actual = serde_json::to_value(actor).unwrap();
                compare(&actual, &expected, &fixture.name);
            }
        }
    }
}
