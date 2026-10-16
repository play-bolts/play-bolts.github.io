//! Lossless, independently decodable full actor tuples. This is not a delta
//! protocol: dropping any unsent intermediate snapshot never loses a baseline.
use serde_json::{Value, json};
use std::sync::OnceLock;

fn actor_fields() -> &'static [String] {
    static FIELDS: OnceLock<Vec<String>> = OnceLock::new();
    FIELDS.get_or_init(|| {
        serde_json::from_str(include_str!("../../shared/actor-fields.json"))
            .expect("actor field schema")
    })
}
pub fn compact_snapshot(mut snapshot: Value) -> Value {
    let fields = actor_fields();
    let Some(actors) = snapshot["actors"].as_array_mut() else {
        return snapshot;
    };
    // A future server field must never silently disappear. If a producer has a
    // different shape it remains a named full snapshot until schema is updated.
    if actors.iter().any(|actor| {
        actor.as_object().is_none_or(|object| {
            object.len() != fields.len() || fields.iter().any(|field| !object.contains_key(field))
        })
    }) {
        return snapshot;
    }
    for actor in actors {
        let Value::Object(mut object) = std::mem::take(actor) else {
            unreachable!("checked actor")
        };
        *actor = Value::Array(
            fields
                .iter()
                .map(|field| object.remove(field).expect("checked field"))
                .collect(),
        );
    }
    snapshot["actorEncoding"] = json!("tuple-v1");
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::{Faction, Simulation};
    fn snapshot() -> Value {
        let mut sim = Simulation::new(72);
        for id in 1..=6 {
            sim.join(id, format!("Player {id}"), Faction::British)
                .unwrap();
        }
        let mut actors = serde_json::to_value(&sim.actors).unwrap();
        for actor in actors.as_array_mut().unwrap() {
            actor["bot"] = json!(false);
            actor["ping"] = json!(57);
            actor["inputTiming"] = json!(sim.input_timing(actor["id"].as_u64().unwrap() as u32));
        }
        json!({"type":"snapshot","inputTiming":"tick-v2","actors":actors,"events":[],"tick":1,"time":1.0/60.0})
    }
    #[test]
    fn tuple_roundtrip_preserves_every_authoritative_field_and_reduces_payload() {
        let full = snapshot();
        let compact = compact_snapshot(full.clone());
        assert_eq!(compact["actorEncoding"], "tuple-v1");
        let mut restored = compact.clone();
        restored.as_object_mut().unwrap().remove("actorEncoding");
        for actor in restored["actors"].as_array_mut().unwrap() {
            *actor = Value::Object(
                actor_fields()
                    .iter()
                    .cloned()
                    .zip(actor.as_array().unwrap().iter().cloned())
                    .collect(),
            );
        }
        assert_eq!(restored, full);
        assert!(compact.to_string().len() < full.to_string().len() * 3 / 4);
    }
    #[test]
    fn unexpected_or_missing_fields_keep_the_full_snapshot_instead_of_losing_data() {
        let mut full = snapshot();
        full["actors"][0]["futureField"] = json!(123.456789123456789);
        assert_eq!(compact_snapshot(full.clone()), full);
        full["actors"][0]
            .as_object_mut()
            .unwrap()
            .remove("futureField");
        full["actors"][0].as_object_mut().unwrap().remove("pose");
        assert_eq!(compact_snapshot(full.clone()), full);
    }
}
