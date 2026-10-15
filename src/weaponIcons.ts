import {WEAPONS,type Faction} from './config';

// Original silhouettes: readable at the small size used by the 2003 killfeed.
const rifles:Record<Faction,string>={
 british:'M3 21 21 16 27 10 61 10 63 8 68 8 68 10 87 10 87 8 91 8 91 10 106 10 106 13 66 13 65 18 52 18 49 15 29 16 22 22 3 25Z M44 17 43 23 54 23 55 17Z',
 russian:'M3 22 23 16 31 12 56 11 57 8 62 8 62 10 97 10 97 7 100 7 100 10 111 10 111 12 62 13 54 16 31 16 24 23 3 26Z M52 15 51 20 58 20 60 15Z',
 german:'M4 20 25 15 32 11 54 11 56 8 60 8 60 11 88 11 88 8 92 8 92 11 104 11 104 14 61 14 55 17 32 16 25 22 4 25Z M50 16 49 21 56 21 58 16Z',
};
export function weaponIcon(faction:Faction,kind:'rifle'|'grenade'|'melee'='rifle',headshot=false):string {
 const name=kind==='rifle'?WEAPONS[faction].name:kind==='grenade'?'Stielhandgranate':'Melee';
 const drawing=kind==='grenade'?'<path d="m47 7 12-3 6 21-12 3zM54 27l7-2 7 25-7 2z" transform="translate(20,-3) rotate(-35 57 26)"/>':
  kind==='melee'?'<path fill-rule="evenodd" d="M2 12h12l5-5c2-2 5-1 6 1l2 3h6c3 0 5 1 5 4 2 1 2 4 0 5 2 2 0 5-2 5 0 3-2 4-5 4h-8l-8-4H2ZM18 11l6 5h9v2H23l-7-5ZM29 20h10v1.5H29ZM28 25h9v1.5h-9ZM12 15h1.5v8H12Z"/><path d="m42 9 4-4m-3 12h6m-7 8 4 4" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>':`<path d="${rifles[faction]}"/>`;
 return `<svg class="weapon-icon ${kind}" viewBox="${kind==='grenade'?'35 -5 75 64':kind==='melee'?'0 0 52 34':'0 0 116 32'}" role="img" aria-label="${name}${headshot?' headshot':''}"><title>${name}${headshot?' · Headshot':''}</title>${drawing}</svg>${headshot?'<span class="headshot" aria-label="Headshot">⊕</span>':''}`;
}
export function stanceIcon(stance:'stand'|'crouch'|'prone'):string {
 const body=stance==='prone'?'<circle cx="37" cy="29" r="3"/><path d="M32 31H18l-9 5m12-5-9-4m18 5 11 5"/>':stance==='crouch'?'<circle cx="28" cy="15" r="3"/><path d="m27 20-6 9 11 3-8 9m-2-12-7 8 5 4m5-19 5 5 9-1"/>':'<circle cx="25" cy="12" r="3"/><path d="M25 17v12m0-10-8 9m8-9 8 9m-8 1-7 13m7-13 7 13"/>';
 return `<svg viewBox="0 0 50 50" role="img" aria-label="${stance}"><path class="stance-triangle" d="M25 3 48 46H2Z"/><g fill="currentColor" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
}
