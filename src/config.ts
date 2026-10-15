export type Faction = 'british' | 'russian' | 'german';
export type Difficulty = 'recruit' | 'regular' | 'veteran';
export type Stance = 'stand' | 'crouch' | 'prone';
export type WeaponSlot = 'rifle' | 'grenade';
export type DamagePart = 'head' | 'torso' | 'lowerTorso' | 'limb' | 'lowerLimb' | 'extremity';
export const WEAPON_SWITCH_SECONDS=.6;
// A 20% faster action takes the former duration divided by 1.2.
export const MELEE_SECONDS=.85/1.2;
/** Every spawn has this many rifle rounds, including the loaded magazine. */
export const SPAWN_AMMO=150;
// An unthrowable carried item: faster movement and a short melee bash, without ammunition.
export const GRENADE={name:'Stielhandgranate',speedMultiplier:1.08} as const;
export const WEAPONS = {
  british: {name:'Lee–Enfield', model:'SMLE Mk III', caliber:'.303 BRITISH', capacity:10, cycle:1.08, reload:3.25, recoil:0.07938, color:0x655941},
  russian: {name:'Mosin–Nagant', model:'M1891/30', caliber:'7.62 × 54mmR', capacity:5, cycle:1.18, reload:2.6, recoil:0.08883, color:0x66644a},
  german: {name:'Kar98k', model:'Karabiner 98 kurz', caliber:'7.92 × 57mm', capacity:5, cycle:1.12, reload:2.55, recoil:0.08316, color:0x555e53},
} as const;
export const FACTIONS: Faction[] = ['british','russian','german'];
export const PLAYER_ACCURACY={hipMultiplier:2,hipBase:.037,movement:.008,adsSpread:.0015,radiusMultiplier:1.21,proneRadiusMultiplier:1.15,stanceFactor:{stand:1,crouch:.6,prone:.5}} as const;
export function playerShotSpread(ads:boolean,stance:Stance,moving:number):number {
 if(ads)return PLAYER_ACCURACY.adsSpread;
 const spread=PLAYER_ACCURACY.hipMultiplier*(PLAYER_ACCURACY.hipBase*PLAYER_ACCURACY.stanceFactor[stance]+moving*PLAYER_ACCURACY.movement);
 const radiusScale=PLAYER_ACCURACY.radiusMultiplier*(stance==='prone'?PLAYER_ACCURACY.proneRadiusMultiplier:1);
 // Scale the projected radius exactly; multiplying angles would only approximate
 // the requested screen-space change. Bullets and crosshairs share this angle.
 return 2*Math.atan(Math.tan(spread/2)*radiusScale);
}
export const DIFFICULTIES = {
 // Perception, motor skill and trigger discipline are independent of tactical skill.
 // Aim error is measured in metres, so shorter sightlines do not create perfect aim.
 recruit: {reaction:1.25,reactionJitter:.45,spread:.032,awareness:20,memory:3,speed:.72,decision:.75,aggression:.4,observation:.30,latency:.20,turn:1.4,tracking:3,error:1.65,errorFloor:1,settle:2.8,hesitation:.65},
 regular: {reaction:.85,reactionJitter:.35,spread:.024,awareness:27,memory:5,speed:.85,decision:.5,aggression:.6,observation:.22,latency:.16,turn:1.9,tracking:4,error:1.2,errorFloor:.72,settle:2.4,hesitation:.45},
 veteran: {reaction:.55,reactionJitter:.30,spread:.018,awareness:34,memory:7,speed:.94,decision:.32,aggression:.78,observation:.16,latency:.12,turn:2.6,tracking:5,error:.85,errorFloor:.5,settle:2,hesitation:.30},
};
export const RULES = { speed:4.8, gravity:22, jump:7.3, radius:0.3, leanDistance:.32*1.3, leanClearance:.35*1.3, roundSeconds:300, botCount:5, respawn:3, spawnProtection:1.5 };
export const HEIGHTS: Record<Stance, number> = {stand:1.65,crouch:1.05,prone:0.43};
export type Box = {x:number;z:number;w:number;d:number;h:number;kind:'crate'|'wall'};
// Half the original floor area; preserve soldier and cover heights.
export const MAP_SCALE = Math.SQRT1_2;
export const ARENA = {width:42*MAP_SCALE, depth:48*MAP_SCALE, wallHeight:7};
export const BOXES: Box[] = [
 ...[[-15,-17,5,5,3.5],[-7,-18,4,4,1.2],[3,-18,5,5,2.3],[14,-18,5,5,3.8],
 [-16,-8,4,4,1.5],[-7,-9,5,5,3.6],[4,-8,4,4,1.1],[14,-8,5,5,2.7],
 [-16,2,5,5,3.5],[-6,1,4,4,1.7],[5,2,5,5,3.4],[15,3,4,4,1.1],
 [-15,13,5,5,2.3],[-6,12,4,4,1.1],[4,13,5,5,2.6],[14,14,5,5,3.6],
 [-5,20,3,3,2.4],[7,21,3,3,1.1]].map(([x,z,w,d,h])=>({x:x*MAP_SCALE,z:z*MAP_SCALE,w:w*MAP_SCALE,d:d*MAP_SCALE,h,kind:'crate' as const})),
 {x:-ARENA.width/2-.5,z:0,w:1,d:ARENA.depth+2,h:7,kind:'wall'}, {x:ARENA.width/2+.5,z:0,w:1,d:ARENA.depth+2,h:7,kind:'wall'},
 {x:0,z:-ARENA.depth/2-.5,w:ARENA.width,d:1,h:7,kind:'wall'}, {x:0,z:ARENA.depth/2+.5,w:ARENA.width,d:1,h:7,kind:'wall'},
];
export const SPAWNS = [{x:-19,z:21},{x:19,z:-21},{x:-19,z:-21},{x:19,z:21},{x:0,z:-22},{x:0,z:21},{x:-19,z:8},{x:19,z:-1}].map(p=>({x:p.x*MAP_SCALE,z:p.z*MAP_SCALE}));
export interface Vec {x:number;y:number;z:number}
export const dist = (a:{x:number;z:number},b:{x:number;z:number})=>Math.hypot(a.x-b.x,a.z-b.z);
export const clamp=(v:number,a:number,b:number)=>Math.min(b,Math.max(a,v));
export const lerp=(a:number,b:number,t:number)=>a+(b-a)*t;
export function rayBox(o:Vec,d:Vec,b:{min:Vec;max:Vec}):number {
 let near=-Infinity,far=Infinity;
 for(const k of ['x','y','z'] as const){
  if(Math.abs(d[k])<1e-8){if(o[k]<b.min[k]||o[k]>b.max[k])return Infinity;continue;}
  const a=(b.min[k]-o[k])/d[k],c=(b.max[k]-o[k])/d[k];near=Math.max(near,Math.min(a,c));far=Math.min(far,Math.max(a,c));
 }
 return far>=Math.max(0,near)?Math.max(0,near):Infinity;
}
export function worldHit(o:Vec,d:Vec):number {
 let result=Infinity;
 for(const b of BOXES)result=Math.min(result,rayBox(o,d,{min:{x:b.x-b.w/2,y:0,z:b.z-b.d/2},max:{x:b.x+b.w/2,y:b.h,z:b.z+b.d/2}}));
 if(d.y<0)result=Math.min(result,-o.y/d.y);
 return result;
}
export function visible(a:Vec,b:Vec):boolean {const len=Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z);return worldHit(a,{x:(b.x-a.x)/len,y:(b.y-a.y)/len,z:(b.z-a.z)/len})>len-0.1;}
export function blocked(x:number,z:number,y=0,r=RULES.radius):boolean{return BOXES.some(b=>y<b.h-0.08&&x>b.x-b.w/2-r&&x<b.x+b.w/2+r&&z>b.z-b.d/2-r&&z<b.z+b.d/2+r);}
// CoD1/UO bolt rifles: 120 base and shared anatomical multipliers.
// No invented short-range falloff inside this small arena. See combat-reference.md.
export function damageFor(part:DamagePart,_distance:number){return Math.round(120*({head:1.5,torso:.9,lowerTorso:.8,limb:.6,lowerLimb:.5,extremity:.4}[part]));}
