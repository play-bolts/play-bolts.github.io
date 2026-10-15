import {clamp,type Faction} from './config';
import type {ImportedWeaponProfile} from './importedWeapons';
import {sampleWeaponAnimation,type WeaponAction,type WeaponPose} from './weaponAnimation';

type Vector=[number,number,number];
const vector=(v:Vector):Vector=>[...v];
function curls(value:WeaponPose['supportCurls']):WeaponPose['supportCurls']{
 return value?{index:vector(value.index),middle:vector(value.middle),ring:vector(value.ring),pinky:vector(value.pinky)}:undefined;
}
/** First-person presentation owns its pose, including nested finger controls.
 * Future view-only hand/camera adjustments must not mutate canonical source
 * contacts shared by world actors or the collision data generator. */
function ownPose(pose:WeaponPose):WeaponPose{
 return{...pose,position:vector(pose.position),rotation:vector(pose.rotation),right:vector(pose.right),rightRotation:vector(pose.rightRotation),left:vector(pose.left),leftRotation:vector(pose.leftRotation),rightElbow:vector(pose.rightElbow),leftElbow:vector(pose.leftElbow),clipPosition:vector(pose.clipPosition),boltOrigin:vector(pose.boltOrigin),boltAxis:vector(pose.boltAxis),stockThumbCurl:pose.stockThumbCurl?vector(pose.stockThumbCurl):undefined,supportCurls:curls(pose.supportCurls),stockCurls:curls(pose.stockCurls)};
}
function aimedCyclePosition(progress:number):Vector{
 const t=clamp(progress,0,1),points:Array<[number,Vector]>=[[0,[0,0,0]],[.30,[.008,-.013,.018]],[.7,[.005,-.008,.006]],[1,[0,0,0]]];
 if(t<=0)return [...points[0][1]];
 for(let i=1;i<points.length;i++)if(t<=points[i][0]){
  const[a,av]=points[i-1],[b,bv]=points[i],w=clamp((t-a)/(b-a),0,1),s=w*w*(3-2*w);
  return av.map((value,axis)=>value+(bv[axis]-value)*s) as Vector;
 }
 return [...points.at(-1)![1]];
}

/** Visual-only entry point for the player's rifle, killcam and spectator
 * follow. Action phase/timing comes from gameplay; first-person framing and
 * arm aesthetics can evolve here without changing canonical world poses.
 * The model inspector uses this same boundary for camera-facing previews. */
export function sampleFirstPersonWeaponAnimation(faction:Faction,action:WeaponAction,progress:number,twoClips=false,profileOverride?:Readonly<ImportedWeaponProfile>|null,presentationADS=0):WeaponPose{
 const pose=ownPose(sampleWeaponAnimation(faction,action,progress,twoClips,profileOverride));
 if(action==='cycle'){
  // Keep the hip bolt operation visible, but retain the smaller motion when
  // shouldered. This composition adjustment never moves the gameplay camera.
  const aimed=aimedCyclePosition(progress),ads=clamp(presentationADS,0,1);
  pose.position=pose.position.map((value,axis)=>value+(aimed[axis]-value)*ads) as Vector;
 }
 return pose;
}
