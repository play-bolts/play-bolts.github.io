import type {Sound} from './audio';
import type {Actor,Shot} from './engine';

type CombatSound=Pick<Sound,'shot'|'melee'|'impact'>;
type CombatActor=Pick<Actor,'faction'>;

/** Contacts belong to the victim's position, independently of the weapon report. */
export function playImpactSound(sound:CombatSound,shot:Shot,actors:readonly CombatActor[],viewedId:number|undefined){
 if(shot.hit===null||shot.hit<0)return;
 const victim=actors[shot.hit];if(!victim)return;
 sound.impact({actor:shot.hit,position:shot.end,local:shot.hit===viewedId,faction:victim.faction},shot.kind);
}

export function playCombatSound(sound:CombatSound,shot:Shot,actors:readonly CombatActor[],viewedId:number|undefined){
 const actor=actors[shot.actor];if(!actor)return;
 const emitter={actor:shot.actor,position:shot.origin,local:shot.actor===viewedId,faction:actor.faction};
 if(shot.kind==='shot')sound.shot(emitter);else sound.melee(emitter);
 playImpactSound(sound,shot,actors,viewedId);
}
