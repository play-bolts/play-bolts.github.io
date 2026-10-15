//! Exact CPU mirror of humanoidMotion.ts and soldierMotion.ts. The input clip
//! samples are shared numeric data, not baked world-space pose approximations.
use crate::hitboxes::{Motion, add, sub, scale, normalize, rotate, qfromeuler, ease, mix_number, vec};
use crate::sim::{Actor,Vec3};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
pub(crate) struct SourceClip {source:String,frames:Vec<Vec<f64>>,average:Vec<f64>}
#[derive(Deserialize)]
pub(crate) struct SourceMotion {bind:BTreeMap<String,Vec<f64>>,clips:BTreeMap<String,SourceClip>}
type Frame=[Vec3;17];
fn unpack(row:&[f64])->Frame {std::array::from_fn(|i|vec([row[i*3],row[i*3+1],row[i*3+2]]))}
fn blend(a:Frame,b:Frame,t:f64)->Frame {std::array::from_fn(|i|add(a[i],scale(sub(b[i],a[i]),t)))}
fn sample(data:&SourceMotion,clip:&str,phase:f64)->Frame {
    let frames=&data.clips[clip].frames;let at=phase.clamp(0.0,1.0)*(frames.len()-1)as f64;let a=at.floor()as usize;let b=(a+1).min(frames.len()-1);
    blend(unpack(&frames[a]),unpack(&frames[b]),at-a as f64)
}
fn looped(data:&SourceMotion,clip:&str,phase:f64)->Frame {
    let source=&data.clips[clip].frames;let count=source.len()-1;let at=phase.rem_euclid(1.0)*count as f64;let index=at.floor()as usize;let f=at-index as f64;
    let corrected=|i:usize,j:usize|source[i][j]-(source[count][j]-source[0][j])*ease(i as f64/count as f64);
    let value=|j:usize|{let a=corrected((index+count-1)%count,j);let b=corrected(index,j);let c=corrected((index+1)%count,j);let d=corrected((index+2)%count,j);0.5*(2.0*b+(c-a)*f+(2.0*a-5.0*b+4.0*c-d)*f*f+(-a+3.0*b-3.0*c+d)*f*f*f)};
    std::array::from_fn(|i|vec([value(i*3),value(i*3+1),value(i*3+2)]))
}
fn average(data:&SourceMotion,clip:&str)->Frame {unpack(&data.clips[clip].average)}
fn bind(data:&SourceMotion,clip:&str)->Frame {unpack(&data.bind[&data.clips[clip].source])}

#[derive(Clone,Copy,Debug)]
pub(crate) struct BodyMotion {
    pub pelvis:Vec3,pub pelvis_rotation:[f64;3],pub spine_rotation:[f64;3],
    pub left_foot:Vec3,pub right_foot:Vec3,pub left_knee:Vec3,pub right_knee:Vec3,
    pub left_foot_rotation:[f64;3],pub right_foot_rotation:[f64;3],
}
pub(crate) fn procedural_boot_clearance(rotation:[f64;3])->f64 {
    let q=qfromeuler(rotation);let mut lowest=f64::INFINITY;
    for x in [-0.081,0.081]{for y in [-0.087,0.099]{for z in [-0.096,0.198]{lowest=lowest.min(rotate(Vec3{x,y,z},q).y);}}}
    0.003-lowest
}

pub(crate) fn sample_body_motion(data:&SourceMotion,actor:&Actor,time:f64,s:Motion)->BodyMotion {
    let speed=s.speed;let crouch=s.crouch;let prone=s.prone;let phase=s.phase.rem_euclid(1.0);
    let moving=ease(speed/0.65);let run=ease((speed-1.8)/1.3);let sprint=ease((speed-3.2)/1.6);
    let idle=looped(data,"Idle_Subtle",time/2.583333+0.17);
    let mut gait=blend(looped(data,"Walk",phase),looped(data,"Jog",phase),run);
    gait=blend(gait,looped(data,"Sprint",phase),sprint);
    let backward=if s.forward<0.0{ease(-s.forward)}else{0.0};let strafe=if s.sideways.abs()>0.05{ease(s.sideways.abs())}else{0.0};
    if backward>0.0{gait=blend(gait,looped(data,"Walk_Backwards",phase),backward);}
    if strafe>0.0{gait=blend(gait,looped(data,if s.sideways<0.0{"Strafe_left"}else{"Strafe_right"},phase),strafe);}
    let mut frame=blend(idle,gait,moving);
    frame=blend(frame,blend(looped(data,"Crouch_Idle",time/3.666667),looped(data,"Crouch_Walk",phase),moving),crouch);
    frame=blend(frame,looped(data,"Crawl",if moving>0.01{phase}else{0.15}),prone);
    let mut stability=run*moving*(1.0-backward)*(1.0-strafe)*(1.0-crouch)*(1.0-prone);
    let jump_age=time-actor.jump_started;let land_age=time-actor.landed_at;
    if !actor.grounded {
        let flight_age=if jump_age.is_finite(){jump_age.max(0.0)}else{0.20};
        let start=sample(data,"Jump_Start",0.16+0.84*ease(flight_age/0.20));
        let air=looped(data,"Jump_air",if jump_age.is_finite(){(jump_age-0.20).max(0.0)/3.125}else{time/3.125});
        let airborne=blend(start,air,ease((flight_age-0.12)/0.16));
        let weight=if jump_age.is_finite(){ease(flight_age/0.07)}else{1.0};
        frame=blend(frame,airborne,weight);stability*=1.0-weight;
    }else if (0.0..0.38).contains(&land_age) {
        let impact=(actor.landing_speed/7.3).clamp(0.0,1.0);let weight=ease(land_age/0.035)*(1.0-ease((land_age-0.24)/0.14))*impact*0.72;
        frame=blend(frame,sample(data,"Jump_Land",(land_age/0.38).clamp(0.0,1.0)),weight);stability*=1.0-weight;
    }
    let hip_line=sub(frame[13],frame[9]);let shoulder_line=sub(frame[6],frame[3]);let torso=sub(frame[1],frame[0]);
    let hip_yaw=(-hip_line.z).atan2(hip_line.x);let hip_roll=hip_line.y.atan2(hip_line.x);
    let pelvis_rotation=[prone*1.52,hip_yaw*0.55*(1.0-prone),hip_roll*0.6*(1.0-prone)*mix_number(1.0,0.45,stability)];
    let mut spine_rotation=[torso.z.atan2(torso.y)-pelvis_rotation[0],(-shoulder_line.z).atan2(shoulder_line.x)*0.65-pelvis_rotation[1],shoulder_line.y.atan2(shoulder_line.x)*0.65*mix_number(1.0,0.20,stability)-pelvis_rotation[2]];
    spine_rotation[0]=mix_number(spine_rotation[0],0.17+spine_rotation[0]*0.12,stability).clamp(-0.22,0.95);
    let bind=blend(bind(data,"Walk"),bind(data,"Crawl"),prone);
    let neutral=blend(blend(average(data,"Idle_Subtle"),average(data,"Crouch_Idle"),crouch),average(data,"Crawl"),prone);
    let mut pelvis=Vec3{x:frame[0].x*0.6*mix_number(1.0,0.40,stability),y:mix_number(mix_number(0.84,0.42,crouch),0.245,prone)+(frame[0].y-neutral[0].y)*0.88,z:mix_number(-0.105*crouch,-0.07,prone)+(frame[0].z-neutral[0].z)*0.55};
    let rotation=qfromeuler(pelvis_rotation);
    let leg=|start:usize,side:f64| {
        let upper=scale(normalize(sub(frame[start+1],frame[start])),0.385);
        let lower=scale(normalize(sub(frame[start+2],frame[start+1])),0.345);
        let hip=add(rotate(Vec3{x:side*0.13,y:-0.015,z:0.0},rotation),pelvis);let knee=add(hip,upper);let foot=add(knee,lower);
        let toe=sub(frame[start+3],frame[start+2]);let bind_toe=sub(bind[start+3],bind[start+2]);
        let pitch=(-toe.y).atan2(toe.x.hypot(toe.z))-(-bind_toe.y).atan2(bind_toe.x.hypot(bind_toe.z));
        let foot_rotation=[mix_number(pitch.clamp(-0.7,0.9),0.10,prone),mix_number(toe.x.atan2(toe.z),std::f64::consts::PI,prone),0.0];
        (knee,foot,foot_rotation)
    };
    let (mut left_knee,mut left_foot,left_rotation)=leg(9,-1.0);let(mut right_knee,mut right_foot,right_rotation)=leg(13,1.0);
    if actor.grounded {
        let source_floor=frame[11].y.min(frame[15].y);let bind_floor=bind[11].y.min(bind[15].y);
        let floor=0.095+(source_floor-bind_floor).max(0.0)*0.88;let correction=floor-left_foot.y.min(right_foot.y);
        pelvis.y+=correction;left_foot.y+=correction;right_foot.y+=correction;left_knee.y+=correction;right_knee.y+=correction;
        for (foot,rotation) in [(&mut left_foot,left_rotation),(&mut right_foot,right_rotation)] {
            foot.z=mix_number(foot.z,pelvis.z+(foot.z-pelvis.z)*0.88,stability);
            let clearance=procedural_boot_clearance(rotation);let lead=ease((foot.z-pelvis.z+0.10)/0.36)*stability;
            foot.y-=(foot.y-clearance).max(0.0)*lead*0.42;
        }
        let settled=0.755+(pelvis.y-0.755)*0.24;let mut hip_height=mix_number(pelvis.y,settled,stability);
        for (foot,side) in [(left_foot,-1.0),(right_foot,1.0)] {
            let offset=rotate(Vec3{x:side*0.13,y:-0.015,z:0.0},rotation);let dx=foot.x-pelvis.x-offset.x;let dz=foot.z-pelvis.z-offset.z;
            let reachable=foot.y-offset.y+(0.725*0.725-dx*dx-dz*dz).max(0.0).sqrt();hip_height=hip_height.min(reachable);
        }
        let shift=hip_height-pelvis.y;pelvis.y=hip_height;left_knee.y+=shift;right_knee.y+=shift;
        left_foot.y=left_foot.y.max(procedural_boot_clearance(left_rotation));right_foot.y=right_foot.y.max(procedural_boot_clearance(right_rotation));
        let body_clearance=(0.245*prone-pelvis.y).max(0.0);pelvis.y+=body_clearance;left_knee.y+=body_clearance;right_knee.y+=body_clearance;
    }
    BodyMotion{pelvis,pelvis_rotation,spine_rotation,left_foot,right_foot,left_knee,right_knee,left_foot_rotation:left_rotation,right_foot_rotation:right_rotation}
}
