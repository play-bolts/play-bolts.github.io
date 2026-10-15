# Bolts multiplayer protocol v1

One authoritative Rust process runs 60 Hz simulations and 20 Hz snapshots. Each lobby allows six human participants, including spectators. Local AI mode never connects. Lobby time is monotonic; rounds last 300 seconds and restart after eight seconds. Empty lobbies expire after five minutes; disconnected members have a 30-second reconnection grace.

HTTP endpoints (JSON):
- `GET /api/health` -> `{ok:true,version:1}`
- `POST /api/session` body `{token?:string}` -> `{playerId:string,token:string}`. Opaque browser-persisted bearer token; random UUID identity, token hash stored server-side. A supplied invalid token receives 401 (client may explicitly create a fresh session).
- `GET /api/lobbies` -> `{lobbies:[{id,name,players,capacity:6,phase:"playing"|"ended"}],version:1}`. Ensure an available lobby on demand. Do not create one on every polling request; join atomically allocates capacity.
- `GET /api/ws` WebSocket. Authenticate in first frame within 5 seconds. No token URL parameters.

Client messages:
- `{type:"hello",version:1,token}` -> `{type:"welcome",playerId}`
- `{type:"join",lobbyId?:string,name,faction,spectator?:boolean}` -> `{type:"joined",lobbyId,lobbyName,actorId,snapshot}`. Missing lobbyId means quick join; choose open lobby, create if none. Missing spectator means combat participation. Existing membership reconnects to the same actor and retains its current mode. Explicit full lobby returns error.
- `{type:"input",seq,forward,right,jump,walk,lean,yaw,pitch,ads,stance?,weapon?,fire,reload,melee,shotTime?}`. Actions are one-packet pulses, server latches once per tick; last seq processed appears as Actor.ack. shotTime is estimated server time bounded to 200ms lag compensation. Input expires after250ms without updates. Pause/chat sends neutral motion/actions/ads.
- `{type:"chat",text}` (max256 Unicode chars, 3 per5seconds)
- `{type:"profile",name}` / `{type:"loadout",faction}` / `{type:"leave"}`
- `{type:"spectate"}` switches an existing participant to spectator without a death or score change. `{type:"loadout",faction}` returns a spectator to combat with a normal protected spawn, including when the faction is unchanged. Both share the loadout rate limit. Spectators have `spectator:true,alive:false`; input cannot move or attack, they have no collision/target body, and ordinary respawn timers do not apply. Camera movement and following stay local. Spectator mode survives reconnection and round restart.
- `{type:"ping",nonce}` -> `{type:"pong",nonce}` for the client's own heartbeat. These JSON values never set scoreboard latency.

The server separately sends a WebSocket control Ping with a random 16-byte nonce every three seconds, with at most one outstanding probe. Browsers automatically echo control Pong. Only a matching, single-use reply on the current authenticated connection is timed by the server. Snapshot `Actor.ping` is integer RTT in milliseconds (capped at 999), or `null` before measurement, after ten seconds without a fresh result, and while disconnected. Connection replacement clears the old reading. Non-browser clients must implement the standard control Pong response; client-supplied timing is ignored.

Server messages:
- `{type:"snapshot",tick,time,remaining,roundNumber,ended,winner,actors,events}`. Each Actor is the complete camelCase frontend Actor minus ai, plus hipSpread, ack, and server-measured ping; `spectator` is always an authoritative boolean. Stable numeric actor IDs per lobby. Finite timestamps use -1000 instead of Infinity. `winner` is actor ID or null and excludes spectators. Event objects match frontend Event with actor/victim stable server IDs; shot payload matches Shot. Snapshots are already per-lobby, never expose other lobbies or persistent UUIDs.
- `{type:"chat",id,actorId,name,text,at}` from authenticated room members only, after persistence.
- `{type:"left"}` for explicit departure.
- `{type:"error",code,message}`. Codes include unauthenticated,invalid_message,lobby_full,lobby_missing,rate_limited,session_replaced,server_busy.

Client remaps self actor to local index0, interpolates remote actors ~100ms, predicts only movement, then reconciles/replays acknowledged inputs. Only server determines hits, damage, ammo, cooldowns, deaths, scores and respawns. Client killcam uses authoritative snapshot/shot history. Menus do not pause online simulation. Disconnect/reconnect and lobby expiration must release slots and persist events exactly once.
