PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
INSERT OR IGNORE INTO schema_migrations VALUES(1, unixepoch('subsec')*1000);
CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL DEFAULT 'Unknown Soldier', created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, name_key TEXT, is_bot INTEGER NOT NULL DEFAULT 0 CHECK(is_bot IN(0,1)), bot_key TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id), opened_at INTEGER NOT NULL, closed_at INTEGER, end_reason TEXT, ip_hash TEXT NOT NULL, ua_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lobbies(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER, close_reason TEXT);
CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY, lobby_id TEXT NOT NULL REFERENCES lobbies(id), round_number INTEGER NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT, winner_player_id TEXT REFERENCES players(id), UNIQUE(lobby_id,round_number));
CREATE TABLE IF NOT EXISTS memberships(id TEXT PRIMARY KEY, lobby_id TEXT NOT NULL REFERENCES lobbies(id), player_id TEXT NOT NULL REFERENCES players(id), actor_id INTEGER NOT NULL, name_at_join TEXT NOT NULL, faction TEXT NOT NULL, joined_at INTEGER NOT NULL, left_at INTEGER, leave_reason TEXT);
-- Regional disconnect grace periods can overlap while a player changes servers.
-- The local Hub still owns one membership per player in each server process.
DROP INDEX IF EXISTS one_live_membership;
CREATE UNIQUE INDEX IF NOT EXISTS one_live_membership_per_lobby ON memberships(player_id,lobby_id) WHERE left_at IS NULL;
CREATE TABLE IF NOT EXISTS match_players(match_id TEXT NOT NULL REFERENCES matches(id), player_id TEXT NOT NULL REFERENCES players(id), name TEXT NOT NULL, faction TEXT NOT NULL, joined_at INTEGER NOT NULL, kills INTEGER NOT NULL DEFAULT 0, deaths INTEGER NOT NULL DEFAULT 0, shots INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(match_id,player_id));
CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL DEFAULT 1, event_type TEXT NOT NULL CHECK(event_type IN('server_start','server_stop','player_enter','player_leave','player_reconnect','profile_change','loadout_change','chat','player_kill','player_death','round_end')), at INTEGER NOT NULL, lobby_id TEXT REFERENCES lobbies(id), match_id TEXT REFERENCES matches(id), connection_id TEXT REFERENCES connections(id), actor_player_id TEXT REFERENCES players(id), target_player_id TEXT REFERENCES players(id), data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)));
CREATE INDEX IF NOT EXISTS events_lobby_time ON events(lobby_id,at,seq);
CREATE INDEX IF NOT EXISTS events_actor_time ON events(actor_player_id,at,seq);
CREATE INDEX IF NOT EXISTS events_target_time ON events(target_player_id,at,seq);
CREATE INDEX IF NOT EXISTS events_match_type ON events(match_id,event_type,seq);
CREATE TABLE IF NOT EXISTS chat_messages(id TEXT PRIMARY KEY REFERENCES events(id), lobby_id TEXT NOT NULL REFERENCES lobbies(id), match_id TEXT NOT NULL REFERENCES matches(id), player_id TEXT NOT NULL REFERENCES players(id), name TEXT NOT NULL, body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 256), created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS chat_lobby_time ON chat_messages(lobby_id,created_at);
CREATE TABLE IF NOT EXISTS combat_events(id TEXT PRIMARY KEY, kill_event_id TEXT NOT NULL UNIQUE REFERENCES events(id), death_event_id TEXT NOT NULL UNIQUE REFERENCES events(id), match_id TEXT NOT NULL REFERENCES matches(id), killer_id TEXT NOT NULL REFERENCES players(id), victim_id TEXT NOT NULL REFERENCES players(id), weapon TEXT NOT NULL CHECK(weapon IN('rifle','melee')), headshot INTEGER NOT NULL CHECK(headshot IN(0,1)), created_at INTEGER NOT NULL);
-- Name-based scores are separate from private UUID authentication. Each combat
-- role snapshots the name at the time, so renaming does not move old scores.
CREATE TABLE IF NOT EXISTS leaderboard_names(name_key TEXT PRIMARY KEY, display_name TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, kills INTEGER NOT NULL DEFAULT 0 CHECK(kills>=0), deaths INTEGER NOT NULL DEFAULT 0 CHECK(deaths>=0));
CREATE INDEX IF NOT EXISTS leaderboard_rank ON leaderboard_names(kills DESC,deaths,name_key);
CREATE TABLE IF NOT EXISTS leaderboard_events(combat_id TEXT NOT NULL REFERENCES combat_events(id), role TEXT NOT NULL CHECK(role IN('kill','death')), player_id TEXT NOT NULL REFERENCES players(id), name_key TEXT NOT NULL REFERENCES leaderboard_names(name_key), created_at INTEGER NOT NULL, PRIMARY KEY(combat_id,role));
CREATE INDEX IF NOT EXISTS leaderboard_recent ON leaderboard_events(created_at,name_key,role);
CREATE INDEX IF NOT EXISTS leaderboard_name_time ON leaderboard_events(name_key,created_at);
-- Feedback is private, including contact information and network pseudonyms.
-- It deliberately has no public read endpoint and is not copied into telemetry.
CREATE TABLE IF NOT EXISTS feedback_requests(id TEXT PRIMARY KEY, message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 2000), email TEXT CHECK(email IS NULL OR length(email) BETWEEN 3 AND 254), ip_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS feedback_rate ON feedback_requests(ip_hash,created_at);
CREATE TABLE IF NOT EXISTS feedback_events(id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES feedback_requests(id), event_type TEXT NOT NULL CHECK(event_type='submitted'), at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS feedback_event_request ON feedback_events(request_id,at);
-- Anonymous site visits are separate from authenticated players and game events.
-- Keep the entire additive migration atomic, including its migration marker.
BEGIN;
CREATE TABLE IF NOT EXISTS visitors(id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL CHECK(first_seen>=0), last_seen INTEGER NOT NULL CHECK(last_seen>=first_seen));
CREATE TABLE IF NOT EXISTS visitor_activity(visitor_id TEXT NOT NULL REFERENCES visitors(id), bucket_start INTEGER NOT NULL CHECK(bucket_start>=0 AND bucket_start%60000=0), first_seen INTEGER NOT NULL CHECK(first_seen>=bucket_start), last_seen INTEGER NOT NULL CHECK(last_seen>=first_seen AND last_seen<bucket_start+60000), PRIMARY KEY(visitor_id,bucket_start));
CREATE INDEX IF NOT EXISTS visitor_activity_time ON visitor_activity(last_seen,visitor_id);
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(3,unixepoch('subsec')*1000);
COMMIT;
-- The directory stores regional records, but their worker owns their lifetime.
-- Cursors identify imported lobbies; connections need explicit ownership because
-- an authenticated socket can be exported before its first lobby event exists.
BEGIN;
CREATE TABLE IF NOT EXISTS cluster_cursors(session TEXT PRIMARY KEY,through INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cluster_connection_owners(connection_id TEXT PRIMARY KEY REFERENCES connections(id),session TEXT NOT NULL REFERENCES cluster_cursors(session));
CREATE INDEX IF NOT EXISTS cluster_connections_session ON cluster_connection_owners(session);
-- Adopt connections imported before ownership tracking was introduced, using
-- recorded lobby associations rather than player identity or ID prefixes.
INSERT OR IGNORE INTO cluster_connection_owners(connection_id,session)
SELECT e.connection_id,c.session FROM events e JOIN cluster_cursors c ON c.session=e.lobby_id
WHERE e.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=4);
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(4,unixepoch('subsec')*1000);
COMMIT;
-- Private first-party network observations and local-play lifecycle receipts.
-- Existing visitor history cannot supply old IPs or local game events.
BEGIN;
CREATE TABLE IF NOT EXISTS visitor_networks(visitor_id TEXT NOT NULL REFERENCES visitors(id), ip_address TEXT NOT NULL CHECK(length(ip_address) BETWEEN 2 AND 45), first_seen INTEGER NOT NULL CHECK(first_seen>=0), last_seen INTEGER NOT NULL CHECK(last_seen>=first_seen), PRIMARY KEY(visitor_id,ip_address));
CREATE TABLE IF NOT EXISTS single_player_events(visitor_id TEXT NOT NULL REFERENCES visitors(id), session_id TEXT NOT NULL CHECK(length(session_id)=36 AND length(replace(session_id,'-',''))=32 AND session_id GLOB '????????-????-4???-[89ab]???-????????????' AND replace(session_id,'-','') NOT GLOB '*[^0-9a-f]*'), event TEXT NOT NULL CHECK(event IN('single_player_start','single_player_stop')), at INTEGER NOT NULL CHECK(at>=0), ip_address TEXT CHECK(ip_address IS NULL OR length(ip_address) BETWEEN 2 AND 45), reason TEXT CHECK(reason IS NULL OR reason IN('quit','page_exit','restart','round_end')), CHECK(event='single_player_stop' OR reason IS NULL), PRIMARY KEY(visitor_id,session_id,event));
CREATE INDEX IF NOT EXISTS single_player_events_time ON single_player_events(at,visitor_id);
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(5,unixepoch('subsec')*1000);
COMMIT;
