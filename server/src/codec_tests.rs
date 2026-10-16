use super::*;
use crate::sim::{Faction, Simulation};
use serde_json::json;

fn sample_snapshot()->Snapshot{
    let mut sim=Simulation::new(72);
    for id in 1..=6 {sim.join(id,format!("^{}Åлексей {id}",id),[Faction::British,Faction::Russian,Faction::German][(id as usize-1)%3]).unwrap();}
    for tick in 1..=80 {for id in 1..=6 {sim.submit_input(id,InputFrame{seq:tick,forward:0.75,right:-0.2,yaw:1.2345678901234567,pitch:-0.1234567890123456,..Default::default()});}sim.tick(1.0/60.0);}
    sim.actors[1].pose=None;
    Snapshot{lobby_id:"fixture-room".into(),event_seq:14,tick:sim.tick_number,time:sim.time,
        remaining:sim.remaining,round_number:sim.round_number,ended:false,winner:None,
        actors:sim.actors.iter().map(|actor|SnapshotActor {actor:actor.clone(),bot:actor.id==6,
            ping:if actor.id==2{None}else{Some(57)},input_timing:sim.input_timing(actor.id)}).collect()}
}
fn same_numbers(a:&Value,b:&Value){
    match (a,b){
        (Value::Number(a),Value::Number(b))=>assert_eq!(a.as_f64(),b.as_f64()),
        (Value::Array(a),Value::Array(b))=>{assert_eq!(a.len(),b.len());for(a,b)in a.iter().zip(b){same_numbers(a,b);}},
        (Value::Object(a),Value::Object(b))=>{assert_eq!(a.len(),b.len());for(k,a)in a{same_numbers(a,b.get(k).unwrap());}},
        _=>assert_eq!(a,b),
    }
}
const MANAGED_LOBBY:&str="arn:aws:gamelift:us-west-2:123456789012:gamesession/fleet-11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222";
fn fixture()->Value{serde_json::from_str(include_str!("../../shared/fixtures/codec-v3.json")).unwrap()}
// Keep bit-exact codec fixtures independent of platform libm results. The
// sample_snapshot test above separately exercises live simulation snapshots.
fn fixture_snapshot()->Snapshot{
    let source=fixture()["snapshot"].clone();
    Snapshot{lobby_id:source["lobbyId"].as_str().unwrap().into(),event_seq:source["eventSeq"].as_u64().unwrap(),
        tick:source["tick"].as_u64().unwrap(),time:source["time"].as_f64().unwrap(),remaining:source["remaining"].as_f64().unwrap(),
        round_number:source["roundNumber"].as_u64().unwrap(),ended:source["ended"].as_bool().unwrap(),winner:source["winner"].as_u64().map(|id|id as u32),
        actors:source["actors"].as_array().unwrap().iter().map(|actor|{let t=&actor["inputTiming"];SnapshotActor{
            actor:serde_json::from_value(actor.clone()).unwrap(),bot:actor["bot"].as_bool().unwrap(),ping:actor["ping"].as_u64().map(|n|n as u16),
            input_timing:InputTiming{received:t["received"].as_u64().unwrap(),late:t["late"].as_u64().unwrap(),missing:t["missing"].as_u64().unwrap(),
                arrival_lead:t["arrivalLead"].as_i64().unwrap() as i32,shots:t["shots"].as_u64().unwrap(),rewind_clamped:t["rewindClamped"].as_u64().unwrap(),shot_age_ms:t["shotAgeMs"].as_f64().unwrap()}
        }}).collect()}
}
fn hex(bytes:&[u8])->String{bytes.iter().map(|n|format!("{n:02x}")).collect()}
fn unhex(value:&str)->Vec<u8>{value.as_bytes().chunks_exact(2).map(|pair|u8::from_str_radix(std::str::from_utf8(pair).unwrap(),16).unwrap()).collect()}
fn tuple()->InputTuple{InputTuple(3,0,12345,67890,3,0.75,-0.25,true,false,-0.416,1.2345678901234567,-0.1234567890123456,true,1,0,true,false,false,123.45678901234567)}
fn input_bytes()->Vec<u8>{rmp_serde::to_vec(&tuple()).unwrap()}

#[test]
fn shared_protocol_schema_matches_typed_serializers(){
    let schema:Value=serde_json::from_str(include_str!("../../shared/wire-schema.json")).unwrap();
    assert_eq!(schema["version"],PROTOCOL_VERSION);
    assert_eq!(schema["inputFields"],json!(["seq","tick","generation","forward","right","jump","walk","lean","yaw","pitch","ads","stance","weapon","fire","reload","melee","shotTime"]));
    assert_eq!(schema["snapshotFields"],json!(["lobbyId","eventSeq","tick","time","remaining","roundNumber","ended","winner","actors"]));
    let snapshot=sample_snapshot();
    let encoded=encode_snapshot(&snapshot).unwrap();
    let raw:Value=rmp_serde::from_slice(&encoded).unwrap();
    let fields:Vec<String>=serde_json::from_str(include_str!("../../shared/actor-fields.json")).unwrap();
    let named=snapshot.named();
    assert_eq!(fields.len(),50);
    for (tuple,actor) in raw[10].as_array().unwrap().iter().zip(named["actors"].as_array().unwrap()){
        assert_eq!(tuple.as_array().unwrap().len(),fields.len());
        for (index,key) in fields.iter().enumerate(){
            if key=="pose" && actor.get("pose").is_some(){same_numbers(&tuple[index],&Value::Array(schema["poseFields"].as_array().unwrap().iter().map(|field|actor["pose"][field.as_str().unwrap()].clone()).collect()));}
            else if key=="inputTiming"{same_numbers(&tuple[index],&Value::Array(schema["timingFields"].as_array().unwrap().iter().map(|field|actor["inputTiming"][field.as_str().unwrap()].clone()).collect()));}
            else{same_numbers(&tuple[index],actor.get(key).unwrap_or(&Value::Null));}
        }
    }
    // Prior protocol-2 already compacted the outer actor. Compare against that
    // baseline, not the substantially larger named JSON representation.
    let mut old=named.clone();old["actorEncoding"]=json!("tuple-v1");
    old["actors"]=Value::Array(named["actors"].as_array().unwrap().iter().map(|a|Value::Array(fields.iter().map(|field|a.get(field).cloned().unwrap_or(Value::Null)).collect())).collect());
    assert!(encoded.len()<old.to_string().len()*3/4,"{} vs {} bytes",encoded.len(),old.to_string().len());
}
#[test]
fn rust_snapshot_fixture_is_current_and_preserves_numeric_values(){
    let snapshot=if std::env::var_os("BOLTS_UPDATE_CODEC_FIXTURE").is_some(){sample_snapshot()}else{fixture_snapshot()};let encoded=encode_snapshot(&snapshot).unwrap();
    if std::env::var_os("BOLTS_UPDATE_CODEC_FIXTURE").is_some(){
        let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/fixtures/codec-v3.json");
        let mut fixture:Value=serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        fixture["snapshot"]=snapshot.named();fixture["snapshotHex"]=json!(hex(&encoded));
        let mut managed=snapshot.clone();managed.lobby_id=MANAGED_LOBBY.into();
        fixture["managedLobbyId"]=json!(MANAGED_LOBBY);fixture["managedSnapshotHex"]=json!(hex(&encode_snapshot(&managed).unwrap()));
        std::fs::write(path,serde_json::to_string_pretty(&fixture).unwrap()+"\n").unwrap();return;
    }
    assert_eq!(hex(&encoded),fixture()["snapshotHex"].as_str().unwrap());
    same_numbers(&snapshot.named(),&fixture()["snapshot"]);
}
#[test]
fn javascript_input_fixture_decodes_losslessly(){
    let fixture=fixture();
    for sample in fixture["inputs"].as_array().unwrap(){
        let decoded=decode_input(&unhex(sample["hex"].as_str().unwrap())).unwrap();
        let mut expected=sample["input"].clone();expected.as_object_mut().unwrap().remove("type");
        same_numbers(&serde_json::to_value(decoded).unwrap(),&expected);
    }
}
#[test]
fn bounded_input_decoder_rejects_bad_shapes_types_depth_and_trailing_bytes(){
    let bytes=input_bytes();assert!(decode_input(&bytes).is_ok());
    for bytes in [vec![],vec![0xc0],vec![0x90],vec![0xdd,0,0,0,19],vec![0xdc,255,255],vec![0x81,0,0],vec![0x91;257]]{assert!(decode_input(&bytes).is_err());}
    for index in 0..bytes.len(){assert!(decode_input(&bytes[..index]).is_err(),"truncated {index}");}
    let mut extra=bytes.clone();extra.push(0);assert!(decode_input(&extra).is_err());
    let mut extended=bytes.clone();extended[2]=20;extended.push(0);assert!(decode_input(&extended).is_err());
    let mut deep=bytes.clone();deep.splice(3..4,[0x91,0x91,0x91,3]);assert!(decode_input(&deep).is_err());
    let mut huge=bytes.clone();huge.splice(3..4,[0xdd,255,255,255,255]);assert!(decode_input(&huge).is_err());
    let mut invalid=tuple();invalid.0=2;assert!(decode_input(&rmp_serde::to_vec(&invalid).unwrap()).is_err());
    invalid=tuple();invalid.1=1;assert!(decode_input(&rmp_serde::to_vec(&invalid).unwrap()).is_err());
    invalid=tuple();invalid.13=3;assert!(decode_input(&rmp_serde::to_vec(&invalid).unwrap()).is_err());
    invalid=tuple();invalid.14=2;assert!(decode_input(&rmp_serde::to_vec(&invalid).unwrap()).is_err());
    invalid=tuple();invalid.2=MAX_SAFE_INTEGER+1;assert!(decode_input(&rmp_serde::to_vec(&invalid).unwrap()).is_err());
    invalid=tuple();invalid.5=f64::NAN;assert!(decode_input(&rmp_serde::to_vec(&invalid).unwrap()).is_err());
    invalid=tuple();invalid.18=f64::INFINITY;assert!(decode_input(&rmp_serde::to_vec(&invalid).unwrap()).is_err());
    invalid=tuple();invalid.5=-0.0;assert_eq!(decode_input(&rmp_serde::to_vec(&invalid).unwrap()).unwrap().forward.to_bits(),(-0.0_f64).to_bits());
}
#[test]
fn snapshot_encoding_rejects_nonfinite_values_and_oversized_states(){
    let mut snapshot=sample_snapshot();snapshot.actors[0].actor.x=f64::NAN;assert!(encode_snapshot(&snapshot).is_err());
    snapshot=sample_snapshot();snapshot.actors[0].actor.pose.as_mut().unwrap().phase=f64::INFINITY;assert!(encode_snapshot(&snapshot).is_err());
    snapshot=sample_snapshot();snapshot.actors.clear();assert!(encode_snapshot(&snapshot).is_err());
    snapshot=sample_snapshot();snapshot.actors.push(snapshot.actors[0].clone());assert!(encode_snapshot(&snapshot).is_err());
    snapshot=sample_snapshot();snapshot.actors[0].actor.name="x".repeat(257);assert!(encode_snapshot(&snapshot).is_err());
}

#[test]
fn compact_numbers_preserve_ieee_bits_without_quantization(){
    for value in [-0.0,0.0,-1000.0,1.0,-1.0,127.0,65535.0,MAX_SAFE_INTEGER as f64,2f64.powi(53),f64::MAX,f64::MIN_POSITIVE,f64::from_bits(1),1.2345678901234567] {
        let encoded=rmp_serde::to_vec(&Number(value)).unwrap();
        let decoded:f64=rmp_serde::from_slice(&encoded).unwrap();
        assert_eq!(decoded.to_bits(),value.to_bits(),"{value}");
    }
    assert_eq!(rmp_serde::to_vec(&Number(0.0)).unwrap().len(),1);
    assert_eq!(rmp_serde::to_vec(&Number(-0.0)).unwrap().len(),9);
}

#[test]
fn managed_lobby_ids_match_existing_512_byte_admission_bound(){
    let mut snapshot=fixture_snapshot();snapshot.lobby_id=MANAGED_LOBBY.into();
    assert_eq!(fixture()["managedLobbyId"],MANAGED_LOBBY);
    assert_eq!(hex(&encode_snapshot(&snapshot).unwrap()),fixture()["managedSnapshotHex"].as_str().unwrap());
    snapshot.lobby_id="🙂".repeat(128);assert!(encode_snapshot(&snapshot).is_ok());
    snapshot.lobby_id.push('x');assert!(encode_snapshot(&snapshot).is_err());
    snapshot.lobby_id="room".into();snapshot.actors[0].actor.name="🙂".repeat(64);assert!(encode_snapshot(&snapshot).is_ok());
    snapshot.actors[0].actor.name.push('x');assert!(encode_snapshot(&snapshot).is_err());
}
