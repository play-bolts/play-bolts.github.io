import manifest from '../shared/audio-candidates.json';
import reviews from '../shared/audio-candidate-reviews.json';

export type AudioCandidateGroup='rifle'|'movement'|'combat'|'voice';
export interface AudioCandidate {
 id:string;group:AudioCandidateGroup;sound:string;label:string;description:string;
 file:string;provider:string;model:string;duration:number;seed:number;sourceInfluence?:number;reviewNote?:string;
}
/** Only completed review assets are entered in this manifest. Gameplay never imports it. */
export const AUDIO_CANDIDATES:readonly AudioCandidate[]=(manifest as AudioCandidate[]).map(candidate=>{
 const reviewNote=(reviews as Record<string,unknown>)[candidate.id];
 return typeof reviewNote==='string'&&reviewNote.trim()?{...candidate,reviewNote}:candidate;
});
export function audioCandidatesFor(group:AudioCandidateGroup,sound:string):readonly AudioCandidate[] {
 return AUDIO_CANDIDATES.filter(candidate=>candidate.group===group&&candidate.sound===sound);
}
