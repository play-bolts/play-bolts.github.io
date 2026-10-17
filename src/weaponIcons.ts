import {WEAPONS,type Faction} from './config';

// Simplified profiles of the licensed rifle models; attribution and adaptation
// details: public/assets/imported-weapons/ATTRIBUTION.md.
const rifles:Record<Faction,string>={
 british:'M5 26 C18 25 42 25 59 24 L75 19 L82 18 L84 11 L89 11 L89 16 L121 16 L122 11 L127 11 L128 17 L175 17 L176 12 L181 12 L182 17 L268 17 L269 11 L272 8 L277 8 L282 12 L282 18 L289 18 L289 22 L283 22 L283 27 L274 27 L273 25 L181 27 L165 29 L133 28 L132 39 L121 42 L108 39 L108 29 L97 29 L95 34 L83 36 L78 33 L74 33 L61 39 L47 43 L6 55 Z M82 29 Q82 34 89 34 Q94 34 95 29 Z',
 russian:'M5 33 Q20 29 34 28 L50 28 L65 31 L76 31 L85 24 L93 19 L94 17 L111 17 L112 19 L140 19 L142 17 L147 17 L148 15 L151 14 L166 15 L169 17 L173 19 L260 19 L261 16 L265 16 L265 19 L286 19 L287 12 L291 12 L291 19 L299 19 L299 22 L267 22 L266 26 L195 27 L181 28 L155 31 L126 31 L124 38 L99 41 L86 41 L83 37 L83 32 L79 32 L65 39 L7 58 Z M87 32 L97 32 L98 38 L91 39 L86 37 Z',
 german:'M5 27 Q23 27 43 25 L57 25 L66 27 L74 25 L81 19 L91 18 L93 13 L102 13 L104 17 L116 17 L117 14 L126 14 L127 17 L141 17 L143 15 L148 14 L165 15 L168 17 L215 18 L216 16 L221 16 L221 18 L242 18 L242 16 L247 16 L247 20 L279 20 L280 14 L283 11 L287 11 L290 15 L290 20 L297 20 L297 23 L249 23 L248 27 L242 28 L241 26 L220 27 L218 29 L163 29 L132 30 L121 30 L119 35 L111 37 L102 36 L99 31 L92 31 L89 34 L80 36 L74 33 L70 33 L58 39 L7 56 Z M103 30 L116 30 Q115 35 110 35 Q104 35 103 30 Z',
};
const meleeDrawing='<path fill-rule="evenodd" d="M1 10H5L9 5Q11 3 13 5L14 7H16.5Q19 7 19 9Q20 10 19 12Q20 14 18 15Q18 18 15 18H10L5 16H1ZM7.2 9.2 8.1 8.4 11.5 11H16.8V12.1H11ZM11.8 13.5H18.1V14.5H11.8ZM12.2 16H16.5V16.9H12.2Z"/><path fill="#b94436" d="M18.8 1.5 23.8 4.7 19.9 7ZM23 9.1 26 11.8 22.8 14.2ZM20.1 17.5 24 20.3 18.8 22Z"/>';
const headshotDrawing='<path d="M12 3.7c-3.6 0-5.4 2.5-5.4 5.4v1.8l1 2.3 1.2.8.1 2.2L4 19v2h16v-2l-4.9-2.8.1-2.2 1.2-.8 1-2.3V9.1c0-2.9-1.8-5.4-5.4-5.4Z"/><g fill="none" stroke="#a53c31" stroke-width="1.45"><circle cx="12" cy="12" r="10.4"/><path d="M12 0v24M0 12h24"/></g>';
export function weaponIcon(faction:Faction,kind:'rifle'|'grenade'|'melee'='rifle',headshot=false):string {
 const name=kind==='rifle'?WEAPONS[faction].name:kind==='grenade'?'Stielhandgranate':'Melee';
 const isHeadshot=kind==='rifle'&&headshot;
 const drawing=isHeadshot?headshotDrawing:kind==='grenade'?'<path d="m47 7 12-3 6 21-12 3zM54 27l7-2 7 25-7 2z" transform="translate(20,-3) rotate(-35 57 26)"/>':kind==='melee'?meleeDrawing:`<path fill-rule="evenodd" d="${rifles[faction]}"/>`;
 const viewBox=isHeadshot?'0 0 24 24':kind==='grenade'?'35 -5 75 64':kind==='melee'?'0 0 26 24':'0 0 304 64';
 return `<svg class="weapon-icon ${isHeadshot?'headshot':kind}" viewBox="${viewBox}" role="img" aria-label="${name}${isHeadshot?' headshot':''}"><title>${name}${isHeadshot?' · Headshot':''}</title>${drawing}</svg>`;
}
export function stanceIcon(stance:'stand'|'crouch'|'prone'):string {
 const body=stance==='prone'?'<circle cx="37" cy="29" r="3"/><path d="M32 31H18l-9 5m12-5-9-4m18 5 11 5"/>':stance==='crouch'?'<circle cx="28" cy="15" r="3"/><path d="m27 20-6 9 11 3-8 9m-2-12-7 8 5 4m5-19 5 5 9-1"/>':'<circle cx="25" cy="12" r="3"/><path d="M25 17v12m0-10-8 9m8-9 8 9m-8 1-7 13m7-13 7 13"/>';
 return `<svg viewBox="0 0 50 50" role="img" aria-label="${stance}"><path class="stance-triangle" d="M25 3 48 46H2Z"/><g fill="currentColor" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
}
