//! Protocol 3: bounded MessagePack input tuples and independently decodable
//! full snapshots. Capture these DTOs under the hub lock; serialize afterwards.
use crate::sim::{Actor, InputFrame, InputTiming, MotionPose, Stance, WeaponSlot};
use serde::{Deserialize, Serialize, Serializer, ser::{Error as _, SerializeTuple}};
use serde_json::{Value, json};
use std::io::Cursor;

pub const PROTOCOL_VERSION: u64 = 3;
pub const MAX_INPUT_BYTES: usize = 256;
pub const MAX_SNAPSHOT_BYTES: usize = 8192;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug)]
pub struct SnapshotActor {
    pub actor: Actor,
    pub bot: bool,
    pub ping: Option<u16>,
    pub input_timing: InputTiming,
}
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub lobby_id: String,
    pub event_seq: u64,
    pub tick: u64,
    pub time: f64,
    pub remaining: f64,
    pub round_number: u64,
    pub ended: bool,
    pub winner: Option<u32>,
    pub actors: Vec<SnapshotActor>,
}
impl Snapshot {
    /// Rare joined-state control message. Invoked by the socket writer outside
    /// the game lock, never by the 20 Hz snapshot producer.
    pub fn named(&self) -> Value {
        let actors: Vec<Value> = self.actors.iter().map(|entry| {
            let mut actor = serde_json::to_value(&entry.actor).expect("actor serialization");
            actor["bot"] = json!(entry.bot);
            actor["ping"] = json!(entry.ping);
            actor["inputTiming"] = json!(entry.input_timing);
            actor
        }).collect();
        json!({"type":"snapshot","inputTiming":"tick-v2","lobbyId":self.lobby_id,
            "eventSeq":self.event_seq,"tick":self.tick,"time":self.time,"remaining":self.remaining,
            "roundNumber":self.round_number,"ended":self.ended,"winner":self.winner,"actors":actors,"events":[]})
    }
}
/// Integer-valued doubles have an exact shorter MessagePack representation.
/// Preserve negative zero and every fractional/large value as IEEE-754 f64.
struct Number(f64);
impl Serialize for Number {
    fn serialize<S:Serializer>(&self, serializer:S)->Result<S::Ok,S::Error>{
        let n=self.0;
        if n.fract()==0.0 && n.abs()<=MAX_SAFE_INTEGER as f64 && !(n==0.0 && n.is_sign_negative()) {
            serializer.serialize_i64(n as i64)
        } else { serializer.serialize_f64(n) }
    }
}
struct PoseTuple(MotionPose);
impl Serialize for PoseTuple {
    fn serialize<S: Serializer>(&self, serializer:S)->Result<S::Ok,S::Error>{
        let p=self.0;
        [p.phase,p.crouch,p.prone,p.aim,p.speed,p.forward,p.sideways].map(Number).serialize(serializer)
    }
}
struct TimingTuple(InputTiming);
impl Serialize for TimingTuple {
    fn serialize<S: Serializer>(&self, serializer:S)->Result<S::Ok,S::Error>{
        let p=self.0;
        (p.received,p.late,p.missing,p.arrival_lead,p.shots,p.rewind_clamped,Number(p.shot_age_ms)).serialize(serializer)
    }
}
impl Serialize for SnapshotActor {
    fn serialize<S: Serializer>(&self, serializer:S)->Result<S::Ok,S::Error>{
        let a=&self.actor;
        let finite=[a.cooldown,a.dead_at,a.death_yaw,a.eye_height,a.hip_spread,a.jump_started,
            a.landed_at,a.landing_speed,a.last_hurt_time,a.last_melee_time,a.last_shot_time,a.lean,
            a.left_ground_at,a.moving,a.pitch,a.recoil,a.reload,a.reload_total,a.spawn_safe,
            a.switch_duration,a.switch_started,a.vy,a.x,a.y,a.yaw,a.z,self.input_timing.shot_age_ms];
        if finite.iter().any(|v| !v.is_finite()) || a.pose.is_some_and(|p|
            [p.phase,p.crouch,p.prone,p.aim,p.speed,p.forward,p.sideways].iter().any(|v|!v.is_finite())) {
            return Err(S::Error::custom("non-finite snapshot number"));
        }
        if a.name.len()>256 || a.ack>MAX_SAFE_INTEGER || a.spawn_generation>MAX_SAFE_INTEGER {
            return Err(S::Error::custom("snapshot actor out of bounds"));
        }
        let mut t=serializer.serialize_tuple(50)?;
        // Keep the order in shared/actor-fields.json; schema tests verify every field.
        t.serialize_element(&a.ack)?;
        t.serialize_element(&a.ads)?;
        t.serialize_element(&a.alive)?;
        t.serialize_element(&a.ammo)?;
        t.serialize_element(&self.bot)?;
        t.serialize_element(&Number(a.cooldown))?;
        t.serialize_element(&Number(a.dead_at))?;
        t.serialize_element(&a.death_headshot)?;
        t.serialize_element(&Number(a.death_yaw))?;
        t.serialize_element(&a.deaths)?;
        t.serialize_element(&Number(a.eye_height))?;
        t.serialize_element(&a.faction)?;
        t.serialize_element(&a.grounded)?;
        t.serialize_element(&Number(a.hip_spread))?;
        t.serialize_element(&a.hits)?;
        t.serialize_element(&a.hp)?;
        t.serialize_element(&a.id)?;
        t.serialize_element(&TimingTuple(self.input_timing))?;
        t.serialize_element(&Number(a.jump_started))?;
        t.serialize_element(&a.kills)?;
        t.serialize_element(&Number(a.landed_at))?;
        t.serialize_element(&Number(a.landing_speed))?;
        t.serialize_element(&Number(a.last_hurt_time))?;
        t.serialize_element(&Number(a.last_melee_time))?;
        t.serialize_element(&Number(a.last_shot_time))?;
        t.serialize_element(&Number(a.lean))?;
        t.serialize_element(&Number(a.left_ground_at))?;
        t.serialize_element(&Number(a.moving))?;
        t.serialize_element(&a.name)?;
        t.serialize_element(&self.ping)?;
        t.serialize_element(&Number(a.pitch))?;
        t.serialize_element(&a.pose.map(PoseTuple))?;
        t.serialize_element(&Number(a.recoil))?;
        t.serialize_element(&Number(a.reload))?;
        t.serialize_element(&Number(a.reload_total))?;
        t.serialize_element(&a.reserve)?;
        t.serialize_element(&a.selected_weapon)?;
        t.serialize_element(&a.shots)?;
        t.serialize_element(&a.spawn_generation)?;
        t.serialize_element(&Number(a.spawn_safe))?;
        t.serialize_element(&a.spectator)?;
        t.serialize_element(&a.stance)?;
        t.serialize_element(&Number(a.switch_duration))?;
        t.serialize_element(&a.switch_from)?;
        t.serialize_element(&Number(a.switch_started))?;
        t.serialize_element(&Number(a.vy))?;
        t.serialize_element(&Number(a.x))?;
        t.serialize_element(&Number(a.y))?;
        t.serialize_element(&Number(a.yaw))?;
        t.serialize_element(&Number(a.z))?;
        t.end()
    }
}
impl Serialize for Snapshot {
    fn serialize<S: Serializer>(&self, serializer:S)->Result<S::Ok,S::Error>{
        if self.actors.is_empty() || self.actors.len()>6 || self.lobby_id.len()>512
            || !self.time.is_finite() || !self.remaining.is_finite()
            || [self.event_seq,self.tick,self.round_number].iter().any(|&n|n>MAX_SAFE_INTEGER) {
            return Err(S::Error::custom("snapshot out of bounds"));
        }
        let mut t=serializer.serialize_tuple(11)?;
        t.serialize_element(&PROTOCOL_VERSION)?;
        t.serialize_element(&1u8)?;
        t.serialize_element(&self.lobby_id)?;
        t.serialize_element(&self.event_seq)?;
        t.serialize_element(&self.tick)?;
        t.serialize_element(&Number(self.time))?;
        t.serialize_element(&Number(self.remaining))?;
        t.serialize_element(&self.round_number)?;
        t.serialize_element(&self.ended)?;
        t.serialize_element(&self.winner)?;
        t.serialize_element(&self.actors)?;
        t.end()
    }
}
pub fn encode_snapshot(snapshot:&Snapshot)->Result<Vec<u8>,rmp_serde::encode::Error>{
    let bytes=rmp_serde::to_vec(snapshot)?;
    if bytes.len()>MAX_SNAPSHOT_BYTES{return Err(rmp_serde::encode::Error::Syntax("snapshot too large".into()));}
    Ok(bytes)
}

// A concrete flat tuple prevents nested containers, maps, strings, extension
// values and attacker-controlled collection allocations before semantic checks.
#[derive(Deserialize, Serialize)]
struct InputTuple(u64,u8,u64,u64,u64,f64,f64,bool,bool,f64,f64,f64,bool,u8,u8,bool,bool,bool,f64);

pub fn decode_input(bytes:&[u8])->Result<InputFrame,&'static str>{
    if bytes.len()>MAX_INPUT_BYTES || bytes.len()<3 || bytes[..3]!=[0xdc,0,19] {
        return Err("invalid input size or tuple");
    }
    let mut cursor=Cursor::new(bytes);
    let input={
        let mut decoder=rmp_serde::Deserializer::new(&mut cursor);
        decoder.set_max_depth(2);
        InputTuple::deserialize(&mut decoder).map_err(|_|"invalid input fields")?
    };
    if cursor.position()!=bytes.len() as u64{return Err("trailing input bytes");}
    let InputTuple(version,kind,seq,tick,generation,forward,right,jump,walk,lean,yaw,pitch,ads,stance,weapon,fire,reload,melee,shot_time)=input;
    if version!=PROTOCOL_VERSION || kind!=0{return Err("incompatible input protocol");}
    if [seq,tick,generation].iter().any(|&n|n>MAX_SAFE_INTEGER)
        || [forward,right,lean,yaw,pitch,shot_time].iter().any(|n|!n.is_finite()) {
        return Err("input number out of bounds");
    }
    let stance=match stance {0=>Stance::Stand,1=>Stance::Crouch,2=>Stance::Prone,_=>return Err("invalid stance")};
    let weapon=match weapon {0=>WeaponSlot::Rifle,1=>WeaponSlot::Grenade,_=>return Err("invalid weapon")};
    Ok(InputFrame{seq,tick:Some(tick),generation:Some(generation),forward,right,yaw,pitch,jump,walk,lean,ads,
        stance:Some(stance),weapon:Some(weapon),fire,reload,melee,shot_time:Some(shot_time)})
}

#[cfg(test)]
#[path="codec_tests.rs"]
mod tests;
