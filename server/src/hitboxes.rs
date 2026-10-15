//! Anatomical damage volumes shared with the client. Movement collision stays
//! cylindrical; these oriented ellipsoids are used only for shot/melee traces.
use crate::sim::{Actor, Faction, Stance, Vec3};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::OnceLock;
use crate::hitbox_motion::{SourceMotion,sample_body_motion,procedural_boot_clearance};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Shape {
    name:String,
    part:HitPart,
    bone:usize,
    center:[f64;3],
    half_size:[f64;3],
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PoseTable {
    shapes:BTreeMap<String,Vec<Shape>>,
    rigs:BTreeMap<String,RigData>,
    motions:SourceMotion,
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct RigData {pub bone_positions:BTreeMap<String,[f64;3]>,pub sole_points:BTreeMap<String,Vec<[f64;3]>>}
fn table() -> &'static PoseTable {
    static TABLE:OnceLock<PoseTable>=OnceLock::new();
    TABLE.get_or_init(||serde_json::from_str(include_str!("../../src/generated/hitboxData.json")).expect("validated shared hit-volume pose table"))
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Transform {pub position:Vec3,pub rotation:[f64;4]}
pub(crate) const IDENTITY:Transform=Transform{position:Vec3{x:0.0,y:0.0,z:0.0},rotation:[0.0,0.0,0.0,1.0]};
pub(crate) fn qmultiply(a:[f64;4],b:[f64;4]) -> [f64;4] {
    [a[0]*b[3]+a[3]*b[0]+a[1]*b[2]-a[2]*b[1],
     a[1]*b[3]+a[3]*b[1]+a[2]*b[0]-a[0]*b[2],
     a[2]*b[3]+a[3]*b[2]+a[0]*b[1]-a[1]*b[0],
     a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]]
}
pub(crate) fn qnormalize(q:[f64;4]) -> [f64;4] {
    let n=q.iter().map(|v|v*v).sum::<f64>().sqrt();
    if n<1e-15 {return [0.0,0.0,0.0,1.0];}
    q.map(|v|v/n)
}
pub(crate) fn qslerp(a:[f64;4],mut b:[f64;4],t:f64) -> [f64;4] {
    if t<=0.0 {return a;}if t>=1.0 {return b;}
    let mut cosine=a.iter().zip(b).map(|(x,y)|x*y).sum::<f64>();
    if cosine<0.0 {b=b.map(|v|-v);cosine=-cosine;}
    if cosine>0.9995 {return qnormalize(std::array::from_fn(|i|a[i]+(b[i]-a[i])*t));}
    let theta=cosine.clamp(-1.0,1.0).acos();let sine=theta.sin();
    let wa=((1.0-t)*theta).sin()/sine;let wb=(t*theta).sin()/sine;
    std::array::from_fn(|i|a[i]*wa+b[i]*wb)
}
pub(crate) fn combine(parent:Transform,child:Transform) -> Transform {
    Transform{position:add(parent.position,rotate(child.position,parent.rotation)),rotation:qmultiply(parent.rotation,child.rotation)}
}
pub(crate) fn axis(index:usize,angle:f64)->[f64;4] {let mut q=[0.0,0.0,0.0,(angle/2.0).cos()];q[index]=(angle/2.0).sin();q}
pub(crate) fn inverse(q:[f64;4])->[f64;4] {[-q[0],-q[1],-q[2],q[3]]}
pub(crate) fn ease(n:f64)->f64 {let t=n.clamp(0.0,1.0);t*t*(3.0-2.0*t)}
pub(crate) fn mix_number(a:f64,b:f64,t:f64)->f64 {a+(b-a)*t}
#[derive(Clone,Copy)]
pub(crate) struct Motion {pub phase:f64,pub crouch:f64,pub prone:f64,pub aim:f64,pub speed:f64,pub forward:f64,pub sideways:f64}
fn motion(actor:&Actor,time:f64)->Motion {
    if let Some(s)=&actor.pose {return Motion{phase:s.phase,crouch:s.crouch,prone:s.prone,aim:s.aim,speed:s.speed,forward:s.forward,sideways:s.sideways};}
    let crouch=if actor.stance==Stance::Crouch{1.0}else{0.0};let prone=if actor.stance==Stance::Prone{1.0}else{0.0};
    let stride=mix_number(mix_number(1.65,2.95,ease((actor.moving-1.8)/3.0)),1.80,crouch);
    let rate=mix_number(mix_number(1.75,1.60,crouch),1.20,prone).min(actor.moving.max(0.0)/mix_number(stride,1.10,prone));
    Motion{phase:time*rate+actor.id as f64*0.19,crouch,prone,aim:if actor.ads{1.0}else{0.0},speed:actor.moving,forward:1.0,sideways:0.0}
}
pub(crate) fn faction(actor:&Actor)->&'static str {match actor.faction {Faction::British=>"british",Faction::Russian=>"russian",Faction::German=>"german"}}
pub(crate) fn rig(actor:&Actor)->&'static RigData {&table().rigs[faction(actor)]}
pub(crate) fn qfrom_unit_vectors(from:Vec3,to:Vec3)->[f64;4] {
    let r=dot(from,to)+1.0;
    if r<f64::EPSILON {
        if from.x.abs()>from.z.abs(){qnormalize([-from.y,from.x,0.0,0.0])}else{qnormalize([0.0,-from.z,from.y,0.0])}
    }else{let q=cross(from,to);qnormalize([q.x,q.y,q.z,r])}
}
pub(crate) fn solve_two_bone(origin:Vec3,target:Vec3,hint:Vec3,upper:f64,lower:f64,plane:Option<(Vec3,f64)>)->(Vec3,Vec3) {
    let delta=sub(target,origin);let distance=dot(delta,delta).sqrt();let direction=if distance<1e-8{vec([0.0,-1.0,0.0])}else{scale(delta,1.0/distance)};
    let distance=distance.clamp((upper-lower).abs()+0.00001,upper+lower-0.00001);let end=add(origin,scale(direction,distance));
    let h=sub(hint,origin);let mut pole=sub(h,scale(direction,dot(h,direction)));
    if dot(pole,pole)<1e-8{pole=cross(direction,if direction.x.abs()<0.8{vec([1.0,0.0,0.0])}else{vec([0.0,0.0,1.0])});}
    pole=normalize(pole);let along=(upper*upper-lower*lower+distance*distance)/(2.0*distance);let height=(upper*upper-along*along).max(0.0).sqrt();let center=add(origin,scale(direction,along));
    if let Some((normal,constant))=plane {if height>1e-8 {
        let up=sub(normal,scale(direction,dot(normal,direction)));let projected=dot(up,up).sqrt();
        if projected>1e-8 {
            let up=scale(up,1.0/projected);let minimum=((constant-dot(center,normal))/(height*projected)).clamp(-1.0,1.0);
            if dot(pole,up)<minimum {let mut across=sub(pole,scale(up,dot(pole,up)));if dot(across,across)<1e-8{across=cross(direction,up);}pole=add(scale(up,minimum),scale(normalize(across),(1.0-minimum*minimum).max(0.0).sqrt()));}
        }
    }}
    (add(center,scale(pole,height)),end)
}

pub(crate) fn sample_hitbox_core(actor:&Actor,time:f64)->([Transform;15],Motion) {
    let s=motion(actor,time);let data=table();let rig=rig(actor);let bind=&rig.bone_positions;
    let body=sample_body_motion(&data.motions,actor,time,s);
    let variation=if actor.pose.is_some(){0}else{actor.id};
    let hurt_age=time-actor.last_hurt_time;let hurt=if (0.0..0.42).contains(&hurt_age){(hurt_age/0.42*std::f64::consts::PI).sin()*(-hurt_age*3.0).exp()}else{0.0};
    let spine_rotation=[body.spine_rotation[0]-actor.pitch*0.15*s.aim-hurt*0.13,body.spine_rotation[1],body.spine_rotation[2]+hurt*if variation%2!=0{-0.06}else{0.06}];
    let neck_rotation=[-body.pelvis_rotation[0]-spine_rotation[0]-actor.pitch*0.73,(time*0.7+variation as f64).sin()*0.016*(1.0-s.aim),0.0];
    let mut bones=[IDENTITY;15];bones[0]=Transform{position:body.pelvis,rotation:qfromeuler(body.pelvis_rotation)};
    bones[1]=combine(bones[0],Transform{position:sub(vec(bind["spine"]),vec(bind["pelvis"])),rotation:qfromeuler(spine_rotation)});
    bones[2]=combine(bones[1],Transform{position:sub(vec(bind["neck"]),vec(bind["spine"])),rotation:qfromeuler(neck_rotation)});
    for (side,suffix,start,foot,knee,foot_rotation) in [("left","L",9,body.left_foot,body.left_knee,body.left_foot_rotation),("right","R",12,body.right_foot,body.right_knee,body.right_foot_rotation)] {
        let hip=vec(bind[&format!("thigh{suffix}")]);let calf=vec(bind[&format!("calf{suffix}")]);let ankle=vec(bind[&format!("foot{suffix}")]);
        let upper=dot(sub(calf,hip),sub(calf,hip)).sqrt();let lower=dot(sub(ankle,calf),sub(ankle,calf)).sqrt();let hip=sub(hip,vec(bind["pelvis"]));
        let q=qfromeuler(foot_rotation);let lowest=rig.sole_points[side].iter().map(|p|rotate(vec(*p),q).y).fold(f64::INFINITY,f64::min);
        let foot=Vec3{y:foot.y+0.003-lowest-procedural_boot_clearance(foot_rotation),..foot};
        let local=|p:Vec3|rotate(sub(p,bones[0].position),inverse(bones[0].rotation));
        let floor=local(vec([0.0,0.11,0.0]));let normal=normalize(sub(local(vec([0.0,1.11,0.0])),floor));
        let (middle,end)=solve_two_bone(hip,local(foot),local(knee),upper,lower,Some((normal,dot(floor,normal))));
        let down=vec([0.0,-1.0,0.0]);
        bones[start]=combine(bones[0],Transform{position:hip,rotation:qfrom_unit_vectors(down,normalize(sub(middle,hip)))});
        bones[start+1]=combine(bones[0],Transform{position:middle,rotation:qfrom_unit_vectors(down,normalize(sub(end,middle)))});
        bones[start+2]=Transform{position:add(rotate(end,bones[0].rotation),bones[0].position),rotation:q};
    }
    (bones,s)
}
/// Samples the same numeric source-rig table and motion state as TypeScript.
/// Rewound actors include their own pose/action timestamps; wall traces and
/// movement radius remain independent from these fitted damage volumes.
pub fn sample_hit_volumes(actor:&Actor,time:f64)->Vec<HitVolume> {
    let data=table();let (mut bones,state)=sample_hitbox_core(actor,time);let spine=bones[1];
    // Arm transforms are completed by the same fixed-length stock-contact IK.
    for (i,arm) in crate::hitbox_arms::sample_arms(actor,time,&bones,state).into_iter().enumerate(){bones[i+3]=arm;}
    let lean=axis(2,actor.lean*(1.0-state.prone*0.6)*0.48);let yaw=axis(1,actor.yaw);let world=Vec3{x:actor.x,y:actor.y,z:actor.z};
    data.shapes[faction(actor)].iter().map(|shape| {
        let bone=bones[shape.bone];let mut center=add(bone.position,rotate(vec(shape.center),bone.rotation));let mut q=bone.rotation;
        if (1..=8).contains(&shape.bone){center=add(spine.position,rotate(sub(center,spine.position),lean));q=qmultiply(lean,q);}
        HitVolume{name:shape.name.clone(),part:shape.part,center:add(world,rotate(center,yaw)),half_size:vec(shape.half_size),rotation:qmultiply(yaw,q)}
    }).collect()
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HitPart {
    Head,
    Torso,
    LowerTorso,
    Limb,
    LowerLimb,
    Extremity,
}

impl HitPart {
    pub fn damage(self) -> u32 {
        match self {
            Self::Head => 180,
            Self::Torso => 108,
            Self::LowerTorso => 96,
            Self::Limb => 72,
            Self::LowerLimb => 60,
            Self::Extremity => 48,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HitVolume {
    pub name: String,
    pub part: HitPart,
    pub center: Vec3,
    pub half_size: Vec3,
    /// Local volume axes in world space, quaternion [x,y,z,w].
    pub rotation: [f64; 4],
}

#[derive(Clone, Debug, Deserialize)]
pub struct Hit {
    pub distance: f64,
    pub part: HitPart,
    pub name: String,
}

pub(crate) fn add(a: Vec3, b: Vec3) -> Vec3 { Vec3 { x:a.x+b.x, y:a.y+b.y, z:a.z+b.z } }
pub(crate) fn sub(a: Vec3, b: Vec3) -> Vec3 { Vec3 { x:a.x-b.x, y:a.y-b.y, z:a.z-b.z } }
pub(crate) fn scale(a: Vec3, n:f64) -> Vec3 { Vec3 { x:a.x*n, y:a.y*n, z:a.z*n } }
pub(crate) fn dot(a: Vec3,b: Vec3) -> f64 { a.x*b.x+a.y*b.y+a.z*b.z }
pub(crate) fn vec(v:[f64;3]) -> Vec3 { Vec3{x:v[0],y:v[1],z:v[2]} }

pub(crate) fn rotate(v:Vec3,q:[f64;4]) -> Vec3 {
    // q must be unit length; sampled rotations are normalized by interpolation.
    let t=Vec3{x:2.0*(q[1]*v.z-q[2]*v.y),y:2.0*(q[2]*v.x-q[0]*v.z),z:2.0*(q[0]*v.y-q[1]*v.x)};
    Vec3{x:v.x+q[3]*t.x+q[1]*t.z-q[2]*t.y,y:v.y+q[3]*t.y+q[2]*t.x-q[0]*t.z,z:v.z+q[3]*t.z+q[0]*t.y-q[1]*t.x}
}
pub(crate) fn qfromeuler(e:[f64;3])->[f64;4] {
    let (s1,c1)=(e[0]/2.0).sin_cos();let (s2,c2)=(e[1]/2.0).sin_cos();let (s3,c3)=(e[2]/2.0).sin_cos();
    [s1*c2*c3+c1*s2*s3,c1*s2*c3-s1*c2*s3,c1*c2*s3+s1*s2*c3,c1*c2*c3-s1*s2*s3]
}
pub(crate) fn cross(a:Vec3,b:Vec3)->Vec3 {Vec3{x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x}}
pub(crate) fn normalize(v:Vec3)->Vec3 {let length=dot(v,v).sqrt();if length>0.0{scale(v,1.0/length)}else{v}}

/// Returns the first forward intersection, in ray parameter units (metres for
/// a unit direction). Empty corners of the old axis-aligned boxes now miss.
pub fn ray_ellipsoid(origin:Vec3,direction:Vec3,volume:&HitVolume) -> Option<f64> {
    let r=volume.half_size;
    if r.x<=0.0 || r.y<=0.0 || r.z<=0.0 {return None;}
    let q=volume.rotation;
    let inverse=[-q[0],-q[1],-q[2],q[3]];
    let p=rotate(sub(origin,volume.center),inverse);
    let d=rotate(direction,inverse);
    let p=Vec3{x:p.x/r.x,y:p.y/r.y,z:p.z/r.z};
    let d=Vec3{x:d.x/r.x,y:d.y/r.y,z:d.z/r.z};
    let a=dot(d,d);
    let b=dot(p,d);
    let c=dot(p,p)-1.0;
    if !a.is_finite() || !b.is_finite() || !c.is_finite() || a<1e-16 {return None;}
    if c<=0.0 {return Some(0.0);}
    let discriminant=b*b-a*c;
    if discriminant<0.0 {return None;}
    let distance=(-b-discriminant.sqrt())/a;
    (distance>=0.0 && distance.is_finite()).then_some(distance)
}

pub fn ray_hit_volumes(origin:Vec3,direction:Vec3,volumes:&[HitVolume]) -> Option<Hit> {
    let mut nearest:Option<Hit>=None;
    for volume in volumes {
        if let Some(distance)=ray_ellipsoid(origin,direction,volume) {
            if nearest.as_ref().is_none_or(|hit|distance<hit.distance) {
                nearest=Some(Hit{distance,part:volume.part,name:volume.name.clone()});
            }
        }
    }
    nearest
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Deserialize)]
    #[serde(rename_all="camelCase")]
    struct CoreFixture {name:String,actor:Actor,time:f64,core_bones:Vec<CoreBone>}
    #[derive(Deserialize)]
    struct CoreBone {index:usize,position:[f64;3],rotation:[f64;4]}
    #[derive(Deserialize)]
    struct RayFixture {origin:Vec3,direction:Vec3,expected:Option<Hit>}
    #[derive(Deserialize)]
    struct VolumeFixture {name:String,actor:Actor,time:f64,volumes:Vec<HitVolume>,rays:Vec<RayFixture>}
    #[test]
    fn complete_body_traces_match_typescript_across_actions_and_stances() {
        let fixtures:Vec<VolumeFixture>=serde_json::from_str(include_str!("../../tests/fixtures/hitbox-parity.json")).unwrap();
        let mut rays=0;let mut worst_distance=0.0_f64;
        for fixture in fixtures {
            let actual=sample_hit_volumes(&fixture.actor,fixture.time);
            assert_eq!(actual.len(),fixture.volumes.len());
            for (volume,expected) in actual.iter().zip(&fixture.volumes) {
                assert_eq!(volume.name,expected.name);assert_eq!(volume.part,expected.part);
                let difference=sub(volume.center,expected.center);
                assert!(dot(difference,difference).sqrt()<0.001,"{} {} center",fixture.name,volume.name);
                // Compare actual surface supports, so a rotation mismatch of
                // a long limb cannot hide behind a close center point.
                for axis in [vec([1.0,0.0,0.0]),vec([0.0,1.0,0.0]),vec([0.0,0.0,1.0])] {
                    let radius=Vec3{x:axis.x*volume.half_size.x,y:axis.y*volume.half_size.y,z:axis.z*volume.half_size.z};
                    let delta=sub(add(volume.center,rotate(radius,volume.rotation)),add(expected.center,rotate(radius,expected.rotation)));
                    assert!(dot(delta,delta).sqrt()<0.001,"{} {} boundary",fixture.name,volume.name);
                }
            }
            for ray in fixture.rays {
                let hit=ray_hit_volumes(ray.origin,ray.direction,&actual);
                assert_eq!(hit.is_some(),ray.expected.is_some(),"{} hit/miss",fixture.name);
                if let (Some(hit),Some(expected))=(hit,ray.expected) {
                    assert_eq!(hit.part,expected.part,"{} damage part",fixture.name);
                    assert_eq!(hit.name,expected.name,"{} volume",fixture.name);
                    let error=(hit.distance-expected.distance).abs();worst_distance=worst_distance.max(error);
                    assert!(error<0.001,"{} ray distance error {}m",fixture.name,error);
                }
                rays+=1;
            }
        }
        assert!(rays>=1332);eprintln!("{rays} TS/Rust traces; worst distance difference {worst_distance:.9}m");
    }
    #[test]
    fn exact_source_motion_and_core_ik_match_typescript() {
        let fixtures:Vec<CoreFixture>=serde_json::from_str(include_str!("../../tests/fixtures/hitbox-parity.json")).unwrap();
        let mut count=0;
        for fixture in fixtures {
            let (bones,_)=sample_hitbox_core(&fixture.actor,fixture.time);
            for expected in fixture.core_bones {
                let actual=bones[expected.index];
                let offset=sub(actual.position,vec(expected.position));
                assert!(dot(offset,offset).sqrt()<1e-8,"{} bone{} position actual {:?}, expected {:?}",fixture.name,expected.index,actual.position,expected.position);
                let same=actual.rotation.iter().zip(expected.rotation).map(|(a,b)|(a-b).powi(2)).sum::<f64>();
                let opposite=actual.rotation.iter().zip(expected.rotation).map(|(a,b)|(a+b).powi(2)).sum::<f64>();
                assert!(same.min(opposite).sqrt()<1e-8,"{} bone{} rotation actual {:?}, expected {:?}",fixture.name,expected.index,actual.rotation,expected.rotation);
                count+=1;
            }
        }
        assert!(count>=27*9);
    }
    fn volume(center:[f64;3],half_size:[f64;3]) -> HitVolume {
        HitVolume{name:"torso".into(),part:HitPart::Torso,center:vec(center),half_size:vec(half_size),rotation:[0.0,0.0,0.0,1.0]}
    }
    #[test]
    fn ellipsoid_rejects_box_corners_and_rearward_rays() {
        let v=volume([0.0,1.1,0.0],[0.20,0.30,0.16]);
        assert!((ray_ellipsoid(vec([0.0,1.1,-2.0]),vec([0.0,0.0,1.0]),&v).unwrap()-1.84).abs()<1e-12);
        assert!(ray_ellipsoid(vec([0.19,1.38,-2.0]),vec([0.0,0.0,1.0]),&v).is_none());
        assert!(ray_ellipsoid(vec([0.0,1.1,-2.0]),vec([0.0,0.0,-1.0]),&v).is_none());
        assert_eq!(ray_ellipsoid(v.center,vec([0.0,0.0,1.0]),&v),Some(0.0));
    }
    #[test]
    fn rotates_the_volume_not_the_damage_band() {
        let mut v=volume([0.0,1.1,0.0],[0.12,0.30,0.06]);
        let s=std::f64::consts::FRAC_1_SQRT_2;
        v.rotation=[0.0,0.0,s,s];
        assert!(ray_ellipsoid(vec([0.20,1.1,-2.0]),vec([0.0,0.0,1.0]),&v).is_some());
        assert!(ray_ellipsoid(vec([0.0,1.3,-2.0]),vec([0.0,0.0,1.0]),&v).is_none());
    }
    #[test]
    fn leg_gap_and_nearest_body_part() {
        let left=volume([-0.12,0.35,0.0],[0.07,0.3,0.08]);
        let right=volume([0.12,0.35,0.0],[0.07,0.3,0.08]);
        assert!(ray_hit_volumes(vec([0.0,0.35,-2.0]),vec([0.0,0.0,1.0]),&[left,right]).is_none());
        let torso=volume([0.0,1.1,1.0],[0.2,0.3,0.16]);
        let mut arm=volume([0.0,1.1,0.0],[0.06,0.2,0.06]);arm.part=HitPart::Limb;
        let hit=ray_hit_volumes(vec([0.0,1.1,-2.0]),vec([0.0,0.0,1.0]),&[torso,arm]).unwrap();
        assert_eq!(hit.part,HitPart::Limb);
        assert!((hit.distance-1.94).abs()<1e-12);
    }
}
