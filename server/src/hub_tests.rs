//! Lifecycle regressions at the authoritative lobby/persistence boundary.
//! Tests use public Hub APIs and real SQLite transactions, with no actor edits.
use crate::{
    db,
    hub::{Config, Hub},
    sim::Faction,
};
use rusqlite::params;
use serde_json::Value;
use std::time::{Duration, Instant};
use tempfile::TempDir;
use tokio::sync::watch;

struct Fixture {
    hub: Hub,
    _directory: TempDir,
}
impl Fixture {
    fn new(max_rooms: usize) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let hub = Hub::new(Config {
            bind: "127.0.0.1:0".into(),
            database: directory.path().join("events.sqlite"),
            origins: vec!["http://127.0.0.1:5173".into()],
            identity_salt: "independent-lifecycle-test-salt-32-bytes".into(),
            empty_seconds: 1000.0,
            reconnect_seconds: 1000.0,
            max_rooms,
            proxy: false,
        })
        .unwrap();
        Self {
            hub,
            _directory: directory,
        }
    }
}

struct Peer {
    player: String,
    connection: String,
    messages: crate::transport::Outgoing,
    cancelled: watch::Receiver<Option<String>>,
}
impl Peer {
    fn fresh(hub: &mut Hub) -> Self {
        let (player, _) = hub.db.session(None).unwrap().unwrap();
        Self::connect(hub, player)
    }
    fn connect(hub: &mut Hub, player: String) -> Self {
        let connection = db::id();
        let (tx, messages) = crate::transport::channel();
        let (cancel, cancelled) = watch::channel(None);
        hub.register(
            &player,
            connection.clone(),
            tx,
            cancel,
            "127.0.0.1",
            "hub-test",
        )
        .unwrap();
        Self {
            player,
            connection,
            messages,
            cancelled,
        }
    }
    fn join(&mut self, hub: &mut Hub, lobby: Option<&str>) -> Value {
        self.join_as(hub, lobby, false)
    }
    fn join_as(&mut self, hub: &mut Hub, lobby: Option<&str>, spectator: bool) -> Value {
        hub.join(
            &self.player,
            &self.connection,
            lobby,
            "^2Test Player",
            Faction::British,
            spectator,
        )
        .unwrap();
        let mut joined = None;
        while let Ok(raw) = self.messages.try_recv() {
            let message: Value = serde_json::from_str(&raw).unwrap();
            if message["type"] == "joined" {
                joined = Some(message);
            }
        }
        joined.expect("successful join sends the authoritative actor snapshot")
    }
}

fn count(hub: &Hub, sql: &str) -> i64 {
    hub.db.test_conn().query_row(sql, &[], |row| row.get(0)).unwrap()
}

#[test]
fn managed_process_owns_one_session_and_stays_closed_when_empty() {
    let mut f = Fixture::new(8);
    f.hub.config.empty_seconds = 0.0;
    f.hub.activate_managed("test:ca", "California").unwrap();
    f.hub.activate_managed("test:ca", "California").unwrap();
    assert!(f.hub.activate_managed("test:ny", "New York").is_err());
    assert_eq!(f.hub.managed_status()["active"], true);
    assert_eq!(count(&f.hub, "SELECT count(*) FROM lobbies"), 1);
    f.hub.tick().unwrap();
    assert_eq!(f.hub.managed_status()["active"], false);
    assert!(f.hub.lobbies().is_err());
    assert_eq!(count(&f.hub, "SELECT count(*) FROM lobbies"), 1);
}

fn bot_count(joined: &Value) -> usize {
    joined["snapshot"]["actors"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| a["bot"] == true)
        .count()
}

#[test]
fn dedicated_duels_enforce_two_seats_without_bots_and_keep_reconnect_reservations() {
    let mut fixture = Fixture::new(32);
    let hub = &mut fixture.hub;
    let list = hub.lobbies().unwrap();
    let rows = list["lobbies"].as_array().unwrap();
    assert_eq!(rows.len(), 4);
    for (row, name) in rows.iter().zip(["Deathmatch", "1v1 Alpha", "1v1 Beta", "1v1 Delta"]) {
        assert_eq!(row["name"], name);
    }
    let deathmatch = rows[0]["id"].as_str().unwrap();
    let mut waiting = Peer::fresh(hub);
    let dm = waiting.join(hub, Some(deathmatch));
    let mut dm_actor = dm["actorId"].clone();
    assert_eq!(bot_count(&dm), 2);
    for row in &rows[1..] {
        assert_eq!(row["capacity"], 2);
        let id = row["id"].as_str().unwrap();
        let mut first = Peer::fresh(hub);
        let joined = first.join(hub, Some(id));
        let first_actor = joined["actorId"].clone();
        assert_eq!(bot_count(&joined), 0);
        assert_eq!(joined["snapshot"]["actors"].as_array().unwrap().len(), 1);
        let mut second = Peer::fresh(hub);
        let joined = second.join(hub, Some(id));
        assert_eq!(bot_count(&joined), 0);
        assert_eq!(joined["snapshot"]["actors"].as_array().unwrap().len(), 2);
        hub.disconnected(&first.player, &first.connection).unwrap();
        for spectator in [false, true] {
            let error = hub.join(&waiting.player, &waiting.connection, Some(id), "Third", Faction::British, spectator).unwrap_err();
            assert_eq!(error.to_string(), "lobby_full");
        }
        // Failed switches preserve the caller's Deathmatch seat.
        assert_eq!(waiting.join(hub, Some(deathmatch))["actorId"], dm_actor);
        let mut reconnect = Peer::connect(hub, first.player.clone());
        assert_eq!(reconnect.join(hub, Some(id))["actorId"], first_actor);
        hub.leave(&reconnect.player, "left", false).unwrap();
        let joined = waiting.join(hub, Some(id));
        assert_eq!(joined["snapshot"]["actors"].as_array().unwrap().len(), 2);
        assert_eq!(bot_count(&joined), 0);
        hub.leave(&waiting.player, "left", false).unwrap();
        hub.leave(&second.player, "left", false).unwrap();
        dm_actor = waiting.join(hub, Some(deathmatch))["actorId"].clone();
    }
    hub.leave(&waiting.player, "left", false).unwrap();
    hub.config.empty_seconds = 0.0;
    hub.tick().unwrap();
    assert_eq!(hub.lobbies().unwrap(), list, "idle rooms retain names, IDs and capacities");
}

#[test]
fn full_dedicated_inventory_never_creates_a_fifth_room() {
    let mut fixture = Fixture::new(32);
    let hub = &mut fixture.hub;
    let list = hub.lobbies().unwrap();
    let mut peers = Vec::new();
    for row in list["lobbies"].as_array().unwrap() {
        for _ in 0..row["capacity"].as_u64().unwrap() {
            let mut peer = Peer::fresh(hub);
            peer.join(hub, row["id"].as_str());
            peers.push(peer);
        }
    }
    let denied = Peer::fresh(hub);
    assert_eq!(hub.join(&denied.player, &denied.connection, None, "Full", Faction::British, false).unwrap_err().to_string(), "server_busy");
    assert_eq!(hub.lobbies().unwrap()["lobbies"].as_array().unwrap().len(), 4);
    assert_eq!(hub.online_count(), 12);
}

#[test]
fn bots_follow_connected_human_threshold_and_persist_without_socket_identities() {
    let mut fixture = Fixture::new(1);
    let hub = &mut fixture.hub;
    let mut first = Peer::fresh(hub);
    assert_eq!(
        hub.online_count(),
        0,
        "unjoined menu sockets are not playing"
    );
    let joined = first.join(hub, None);
    let lobby = joined["lobbyId"].as_str().unwrap().to_owned();
    assert_eq!(bot_count(&joined), 2);
    assert_eq!(hub.online_count(), 1);
    assert!(
        joined["snapshot"]["actors"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|a| a["bot"] == true)
            .all(|a| a["ping"].is_null())
    );
    let mut second = Peer::fresh(hub);
    assert_eq!(bot_count(&second.join_as(hub, Some(&lobby), true)), 2);
    assert_eq!(
        hub.online_count(),
        2,
        "spectators count as connected humans"
    );
    let mut third = Peer::fresh(hub);
    assert_eq!(bot_count(&third.join(hub, Some(&lobby))), 0);
    assert_eq!(hub.online_count(), 3);
    hub.leave(&third.player, "left", false).unwrap();
    assert_eq!(bot_count(&first.join(hub, Some(&lobby))), 2);
    hub.leave(&second.player, "left", false).unwrap();
    assert_eq!(bot_count(&first.join(hub, Some(&lobby))), 2);
    hub.disconnected(&first.player, &first.connection).unwrap();
    assert_eq!(hub.online_count(), 0);
    assert_eq!(hub.lobbies().unwrap()["lobbies"][0]["bots"], 0);
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM memberships m JOIN players p ON p.id=m.player_id WHERE p.is_bot=1 AND m.left_at IS NULL"
        ),
        0
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM connections c JOIN players p ON p.id=c.player_id WHERE p.is_bot=1"
        ),
        0
    );
    assert_eq!(
        count(hub, "SELECT count(*) FROM players WHERE is_bot=1"),
        2,
        "repeated bot admission reuses per-lobby identities"
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events e JOIN players p ON p.id=e.actor_player_id WHERE p.is_bot=1 AND e.event_type='player_enter'"
        ),
        4
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events e JOIN players p ON p.id=e.actor_player_id WHERE p.is_bot=1 AND e.event_type='player_leave'"
        ),
        4
    );
    assert_eq!(
        count(hub, "SELECT count(*) FROM pragma_foreign_key_check"),
        0
    );
}

#[test]
fn disconnected_human_reservations_and_reconnect_take_priority_over_bots() {
    let mut fixture = Fixture::new(1);
    let hub = &mut fixture.hub;
    let mut peers = Vec::new();
    let mut lobby = None;
    for _ in 0..6 {
        let mut peer = Peer::fresh(hub);
        let joined = peer.join(hub, lobby.as_deref());
        lobby = Some(joined["lobbyId"].as_str().unwrap().to_owned());
        assert!(joined["snapshot"]["actors"].as_array().unwrap().len() <= 6);
        peers.push(peer);
    }
    for peer in peers.iter().skip(2) {
        hub.disconnected(&peer.player, &peer.connection).unwrap();
    }
    assert_eq!(hub.online_count(), 2);
    assert_eq!(
        bot_count(&peers[0].join(hub, lobby.as_deref())),
        0,
        "retained human seats cannot be stolen by AI"
    );
    hub.leave(&peers[5].player, "timeout", false).unwrap();
    assert_eq!(bot_count(&peers[0].join(hub, lobby.as_deref())), 1);
    hub.leave(&peers[4].player, "timeout", false).unwrap();
    let snapshot = peers[0].join(hub, lobby.as_deref());
    assert_eq!(bot_count(&snapshot), 2);
    assert_eq!(snapshot["snapshot"]["actors"].as_array().unwrap().len(), 6);
    let mut reconnected = Peer::connect(hub, peers[2].player.clone());
    assert_eq!(bot_count(&reconnected.join(hub, lobby.as_deref())), 0);
    assert_eq!(hub.online_count(), 3);
    hub.shutdown().unwrap();
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM memberships WHERE left_at IS NULL"
        ),
        0
    );
}

#[test]
fn per_player_latency_is_shared_authority_and_clears_on_disconnect_or_replacement() {
    let mut fixture = Fixture::new(1);
    let hub = &mut fixture.hub;
    let mut first = Peer::fresh(hub);
    let joined = first.join(hub, None);
    let first_actor = joined["actorId"].clone();
    let lobby = joined["lobbyId"].as_str().unwrap().to_owned();
    assert_eq!(joined["snapshot"]["actors"][0]["ping"], Value::Null);
    let mut second = Peer::fresh(hub);
    let second_actor = second.join(hub, Some(&lobby))["actorId"].clone();
    let now = Instant::now() - Duration::from_secs(1);
    for (peer, ms) in [(&first, 12), (&second, 174)] {
        let nonce = hub.ping(&peer.player, &peer.connection, now).unwrap();
        // A different or replaced connection cannot submit another user's reply.
        hub.pong(&peer.player, "invalid-connection", &nonce, now);
        hub.pong(
            &peer.player,
            &peer.connection,
            &nonce,
            now + Duration::from_millis(ms),
        );
    }
    let readings = |message: &Value| {
        message["snapshot"]["actors"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|actor| actor["bot"] != true)
            .map(|actor| (actor["id"].clone(), actor["ping"].clone()))
            .collect::<Vec<_>>()
    };
    let expected = vec![
        (first_actor.clone(), Value::from(12)),
        (second_actor, Value::from(174)),
    ];
    assert_eq!(readings(&first.join(hub, Some(&lobby))), expected);
    assert_eq!(readings(&second.join(hub, Some(&lobby))), expected);
    hub.disconnected(&second.player, &second.connection)
        .unwrap();
    let after_disconnect = readings(&first.join(hub, Some(&lobby)));
    assert_eq!(after_disconnect[1].1, Value::Null);
    let old_probe = hub
        .ping(
            &first.player,
            &first.connection,
            now + Duration::from_millis(500),
        )
        .unwrap();
    let mut replacement = Peer::connect(hub, first.player.clone());
    hub.pong(
        &first.player,
        &first.connection,
        &old_probe,
        now + Duration::from_millis(600),
    );
    let after_replace = replacement.join(hub, Some(&lobby));
    assert_eq!(after_replace["actorId"], first_actor);
    assert_eq!(readings(&after_replace)[0].1, Value::Null);
    let old = Instant::now() - Duration::from_secs(20);
    let stale_probe = hub
        .ping(&replacement.player, &replacement.connection, old)
        .unwrap();
    hub.pong(
        &replacement.player,
        &replacement.connection,
        &stale_probe,
        old + Duration::from_millis(55),
    );
    assert_eq!(
        readings(&replacement.join(hub, Some(&lobby)))[0].1,
        Value::Null
    );
}

#[test]
fn spectator_transitions_persist_mode_without_combat_and_reconnect_preserves_it() {
    let mut fixture = Fixture::new(1);
    let hub = &mut fixture.hub;
    let mut peer = Peer::fresh(hub);
    let joined = peer.join_as(hub, None, true);
    let actor = joined["actorId"].clone();
    let lobby = joined["lobbyId"].as_str().unwrap().to_owned();
    assert_eq!(joined["snapshot"]["actors"][0]["spectator"], true);
    assert_eq!(joined["snapshot"]["actors"][0]["alive"], false);
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='player_enter' AND json_extract(data,'$.spectator')=1"
        ),
        1
    );
    hub.loadout(&peer.player, Faction::British).unwrap();
    let combat = peer.join(hub, Some(&lobby));
    assert_eq!(combat["snapshot"]["actors"][0]["spectator"], false);
    assert_eq!(combat["snapshot"]["actors"][0]["alive"], true);
    hub.spectate(&peer.player).unwrap();
    hub.spectate(&peer.player).unwrap();
    hub.disconnected(&peer.player, &peer.connection).unwrap();
    let mut replacement = Peer::connect(hub, peer.player.clone());
    let resumed = replacement.join(hub, None);
    assert_eq!(resumed["actorId"], actor);
    assert_eq!(resumed["snapshot"]["actors"][0]["spectator"], true);
    assert_eq!(resumed["snapshot"]["actors"][0]["deaths"], 0);
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM memberships WHERE player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        1
    );
    assert_eq!(count(hub, "SELECT count(*) FROM combat_events"), 0);
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='loadout_change' AND json_extract(data,'$.spectator')=1"
        ),
        1
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='loadout_change' AND json_extract(data,'$.spectator')=0"
        ),
        1
    );
    assert_eq!(count(hub, "SELECT sum(kills+deaths) FROM match_players"), 0);
}

#[test]
fn spectators_share_the_same_six_seat_admission_limit_and_release_on_leave() {
    let mut fixture = Fixture::new(1);
    let hub = &mut fixture.hub;
    let mut observer = Peer::fresh(hub);
    let lobby = observer.join_as(hub, None, true)["lobbyId"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut others = Vec::new();
    for _ in 0..5 {
        let mut peer = Peer::fresh(hub);
        peer.join(hub, Some(&lobby));
        others.push(peer);
    }
    let mut seventh = Peer::fresh(hub);
    let error = hub
        .join(
            &seventh.player,
            &seventh.connection,
            Some(&lobby),
            "Observer",
            Faction::British,
            true,
        )
        .unwrap_err();
    assert_eq!(error.to_string(), "lobby_full");
    assert_eq!(hub.lobbies().unwrap()["lobbies"][0]["players"], 6);
    hub.leave(&observer.player, "left", false).unwrap();
    let joined = seventh.join_as(hub, Some(&lobby), true);
    let actor = joined["actorId"].clone();
    assert!(
        joined["snapshot"]["actors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["id"] == actor && a["spectator"] == true)
    );
    assert_eq!(count(hub, "SELECT count(*) FROM combat_events"), 0);
}

#[test]
fn replacing_a_connection_keeps_the_actor_and_does_not_duplicate_membership() {
    let mut fixture = Fixture::new(2);
    let hub = &mut fixture.hub;
    let mut old = Peer::fresh(hub);
    let initial = old.join(hub, None);
    let actor = initial["actorId"].as_u64().unwrap();
    let lobby = initial["lobbyId"].as_str().unwrap().to_owned();

    let mut replacement = Peer::connect(hub, old.player.clone());
    assert_eq!(old.cancelled.borrow().as_deref(), Some("session_replaced"));
    let notice: Value = serde_json::from_str(&old.messages.try_recv().unwrap()).unwrap();
    assert_eq!(notice["code"], "session_replaced");
    // The previous socket's delayed cleanup must not disconnect the new socket.
    hub.disconnected(&old.player, &old.connection).unwrap();
    assert_eq!(hub.connections[&old.player].cid, replacement.connection);
    let resumed = replacement.join(hub, None);
    assert_eq!(resumed["actorId"], actor);
    assert_eq!(resumed["lobbyId"], lobby);
    assert_eq!(resumed["snapshot"]["actors"].as_array().unwrap().len(), 3);
    assert_eq!(resumed["snapshot"]["actors"][0]["deaths"], 0);
    hub.tick().unwrap();
    assert!(replacement.cancelled.borrow().is_none());
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM memberships WHERE player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        1
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='player_enter' AND actor_player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        1
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='player_leave' AND actor_player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        0
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='player_reconnect'"
        ),
        1
    );
    let reasons: (Option<String>, Option<i64>) = hub
        .db
        .test_conn()
        .query_row(
            "SELECT end_reason,closed_at FROM connections WHERE id=?1",
            &[&old.connection],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(reasons.0.as_deref(), Some("session_replaced"));
    assert!(reasons.1.is_some());
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM connections WHERE closed_at IS NULL"
        ),
        1
    );
}

#[test]
fn changing_loadout_then_immediately_leaving_persists_linked_kill_death_and_stats() {
    let mut fixture = Fixture::new(1);
    let hub = &mut fixture.hub;
    let mut player = Peer::fresh(hub);
    player.join(hub, None);
    hub.loadout(&player.player, Faction::German).unwrap();
    // No tick occurs between the change and departure. A deferred event drain
    // would lose the actor-to-UUID mapping and silently drop these combat rows.
    hub.leave(&player.player, "left", true).unwrap();
    hub.leave(&player.player, "left", true).unwrap();
    hub.tick().unwrap();
    assert_eq!(count(hub, "SELECT count(*) FROM combat_events"), 1);
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='player_kill'"
        ),
        1
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='player_death'"
        ),
        1
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='player_leave' AND actor_player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        1
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='loadout_change'"
        ),
        1
    );
    let record: (String, String, String, String, String, String) = hub.db.test_conn().query_row(
        "SELECT c.killer_id,c.victim_id,k.actor_player_id,d.actor_player_id,json_extract(k.data,'$.combatId'),json_extract(d.data,'$.combatId') FROM combat_events c JOIN events k ON k.id=c.kill_event_id JOIN events d ON d.id=c.death_event_id",
        &[], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
    ).unwrap();
    assert_eq!(record.0, player.player);
    assert_eq!(record.1, player.player);
    assert_eq!(record.2, player.player);
    assert_eq!(record.3, player.player);
    assert_eq!(record.4, record.5);
    let stats: (i64, i64, String) = hub
        .db
        .test_conn()
        .query_row(
            "SELECT kills,deaths,faction FROM match_players WHERE player_id=?1",
            &[&player.player],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(stats, (-1, 1, "german".into()));
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM memberships WHERE left_at IS NULL AND player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        0
    );
    assert_eq!(
        count(hub, "SELECT count(*) FROM pragma_foreign_key_check"),
        0
    );
}

#[test]
fn leaving_and_rejoining_preserves_cumulative_match_statistics() {
    let mut fixture = Fixture::new(1);
    let hub = &mut fixture.hub;
    let mut player = Peer::fresh(hub);
    let first = player.join(hub, None);
    let lobby = first["lobbyId"].as_str().unwrap().to_owned();
    hub.loadout(&player.player, Faction::German).unwrap();
    hub.leave(&player.player, "left", true).unwrap();
    let second = player.join(hub, Some(&lobby));
    assert_ne!(second["actorId"], first["actorId"]);
    let fresh_actor = &second["snapshot"]["actors"][0];
    assert_eq!(fresh_actor["kills"], 0);
    assert_eq!(fresh_actor["deaths"], 0);
    hub.loadout(&player.player, Faction::Russian).unwrap();
    hub.leave(&player.player, "left", true).unwrap();
    let totals: (i64, i64) = hub
        .db
        .test_conn()
        .query_row(
            "SELECT kills,deaths FROM match_players WHERE player_id=?1",
            &[&player.player],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        totals,
        (-2, 2),
        "new actor counters must add to persisted match totals"
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM match_players WHERE player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        1
    );
    assert_eq!(count(hub, "SELECT count(*) FROM combat_events"), 2);
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='player_enter' AND actor_player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        2
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='player_leave' AND actor_player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        2
    );
}

#[test]
fn per_room_capacity_and_global_room_cap_never_evict_an_existing_seat() {
    let mut fixture = Fixture::new(2);
    let hub = &mut fixture.hub;
    let mut peers = Vec::new();
    let mut first_lobby = String::new();
    let mut second_lobby = String::new();
    for i in 0..8 {
        let mut peer = Peer::fresh(hub);
        let joined = peer.join(hub, None);
        let lobby = joined["lobbyId"].as_str().unwrap();
        if i == 0 {
            first_lobby = lobby.into();
        }
        if i == 6 {
            second_lobby = lobby.into();
        }
        assert_eq!(lobby, if i < 6 { &first_lobby } else { &second_lobby });
        peers.push(peer);
    }
    assert_ne!(first_lobby, second_lobby);
    let list = hub.lobbies().unwrap();
    assert_eq!(list["lobbies"].as_array().unwrap().len(), 2);
    for row in list["lobbies"].as_array().unwrap() {
        assert_eq!(row["players"], row["capacity"]);
    }
    let denied = Peer::fresh(hub);
    let full = hub
        .join(
            &denied.player,
            &denied.connection,
            Some(&first_lobby),
            "Denied",
            Faction::British,
            false,
        )
        .unwrap_err();
    assert_eq!(full.to_string(), "lobby_full");
    let busy = hub
        .join(
            &denied.player,
            &denied.connection,
            None,
            "Denied",
            Faction::British,
            false,
        )
        .unwrap_err();
    assert_eq!(busy.to_string(), "server_busy");
    let mover = &peers[6];
    assert_eq!(
        hub.join(
            &mover.player,
            &mover.connection,
            Some(&first_lobby),
            "Move",
            Faction::German,
            false,
        )
        .unwrap_err()
        .to_string(),
        "lobby_full"
    );
    let retained: String = hub
        .db
        .test_conn()
        .query_row(
            "SELECT lobby_id FROM memberships WHERE player_id=?1 AND left_at IS NULL",
            &[&mover.player],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, second_lobby);
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM memberships WHERE left_at IS NULL AND player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        8
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='player_enter' AND actor_player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        8
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='player_leave' AND actor_player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        0
    );
}

#[test]
fn reconnect_before_grace_keeps_actor_but_timeout_releases_the_seat_once() {
    let mut fixture = Fixture::new(1);
    let hub = &mut fixture.hub;
    let mut original = Peer::fresh(hub);
    let joined = original.join(hub, None);
    let actor = joined["actorId"].as_u64().unwrap();
    let lobby = joined["lobbyId"].as_str().unwrap().to_owned();
    hub.disconnected(&original.player, &original.connection)
        .unwrap();
    hub.tick().unwrap();
    assert_eq!(hub.lobbies().unwrap()["lobbies"][0]["players"], 1);
    let mut resumed = Peer::connect(hub, original.player.clone());
    assert_eq!(resumed.join(hub, Some(&lobby))["actorId"], actor);
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='player_enter' AND actor_player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        1
    );
    hub.disconnected(&resumed.player, &resumed.connection)
        .unwrap();
    hub.config.reconnect_seconds = 0.0;
    hub.tick().unwrap();
    hub.tick().unwrap();
    assert_eq!(hub.lobbies().unwrap()["lobbies"][0]["players"], 0);
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='player_leave' AND actor_player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        1
    );
    let reason: String = hub
        .db
        .test_conn()
        .query_row(
            "SELECT leave_reason FROM memberships WHERE player_id=?1",
            &[&original.player],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(reason, "timeout");
    let mut fresh = Peer::connect(hub, original.player.clone());
    let rejoined = fresh.join(hub, Some(&lobby));
    assert_ne!(rejoined["actorId"], actor);
    assert_eq!(rejoined["snapshot"]["actors"].as_array().unwrap().len(), 3);
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='player_enter' AND actor_player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        2
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM memberships WHERE left_at IS NULL AND player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        1
    );
}

#[test]
fn dedicated_room_survives_idle_timeout_without_changing_identity() {
    let mut fixture = Fixture::new(1);
    let hub = &mut fixture.hub;
    let mut player = Peer::fresh(hub);
    let original = player.join(hub, None);
    let lobby = original["lobbyId"].as_str().unwrap().to_owned();
    hub.config.empty_seconds = 0.0;
    // An occupied room never expires, even with a zero idle threshold.
    hub.tick().unwrap();
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM lobbies WHERE closed_at IS NOT NULL"
        ),
        0
    );
    hub.leave(&player.player, "left", false).unwrap();
    hub.tick().unwrap();
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM lobbies WHERE close_reason='inactive' AND closed_at IS NOT NULL"
        ),
        0
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM matches WHERE end_reason='inactive' AND ended_at IS NOT NULL"
        ),
        0
    );
    let next = hub.lobbies().unwrap();
    assert_eq!(next["lobbies"].as_array().unwrap().len(), 1);
    assert_eq!(next["lobbies"][0]["id"], lobby);
    assert_eq!(next["lobbies"][0]["players"], 0);
    // Polling the lobby browser should reuse the new standby room.
    assert_eq!(hub.lobbies().unwrap(), next);
    assert_eq!(
        count(hub, "SELECT count(*) FROM lobbies WHERE closed_at IS NULL"),
        1
    );
}

#[test]
fn shutdown_finishes_connected_and_reconnect_grace_members_exactly_once() {
    let mut fixture = Fixture::new(1);
    let hub = &mut fixture.hub;
    let mut connected = Peer::fresh(hub);
    let joined = connected.join(hub, None);
    let mut grace = Peer::fresh(hub);
    grace.join(hub, joined["lobbyId"].as_str());
    hub.disconnected(&grace.player, &grace.connection).unwrap();
    hub.shutdown().unwrap();
    assert!(hub.connections.is_empty());
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM memberships WHERE left_at IS NULL AND player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        0
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM connections WHERE closed_at IS NULL"
        ),
        0
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='player_leave' AND actor_player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        2
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM memberships WHERE leave_reason='server_stop' AND player_id IN (SELECT id FROM players WHERE is_bot=0)"
        ),
        2
    );
    assert_eq!(
        count(
            hub,
            "SELECT count(*) FROM events WHERE event_type='server_stop'"
        ),
        1
    );
    assert_eq!(
        count(hub, "SELECT count(*) FROM lobbies WHERE closed_at IS NULL"),
        0
    );
    assert_eq!(
        count(hub, "SELECT count(*) FROM matches WHERE ended_at IS NULL"),
        0
    );
    for player in [&connected.player, &grace.player] {
        let leaves: i64 = hub.db.test_conn().query_row(
            "SELECT count(*) FROM events WHERE event_type='player_leave' AND actor_player_id=?1", params![player], |row| row.get(0),
        ).unwrap();
        assert_eq!(leaves, 1);
    }
}
