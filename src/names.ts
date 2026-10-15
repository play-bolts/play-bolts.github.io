export const DEFAULT_PLAYER_NAME='Unknown Soldier';
export const PLAYER_NAME_PREFERENCE_VERSION=1;
export const MAX_NAME_LENGTH=24;
export const MAX_NAME_RAW_LENGTH=96;

export type NameColorCode='0'|'1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9';
export interface NameSegment {text:string;code:NameColorCode}

// 0–7 follow the id Tech color convention. 8/9 are compatibility extensions:
// UO's 8 varies by map; Bolts uses dark green for this single-arena palette.
export const NAME_COLORS:Readonly<Record<NameColorCode,string>>=Object.freeze({
 '0':'#000000','1':'#ff0000','2':'#00ff00','3':'#ffff00','4':'#0000ff',
 '5':'#00ffff','6':'#ff00ff','7':'#ffffff','8':'#008000','9':'#808080',
});

interface NameCharacter {text:string;code:NameColorCode;explicit:boolean}
function characters(value:string):NameCharacter[]{
 const points=Array.from(value),result:NameCharacter[]=[];
 let code:NameColorCode='7',explicit=false;
 for(let i=0;i<points.length;i++){
  if(points[i]==='^'&&/^[0-9]$/.test(points[i+1]??'')){code=points[++i] as NameColorCode;explicit=true;}
  else result.push({text:points[i],code,explicit});
 }
 return result;
}

/** Preserve color codes but bound names, normalize whitespace and remove controls. */
export function sanitizePlayerName(input:unknown):string {
 if(typeof input!=='string')return DEFAULT_PLAYER_NAME;
 const bounded=input.slice(0,MAX_NAME_RAW_LENGTH)
  // Do not retain a lone surrogate when the raw input limit cuts an emoji.
  .replace(/[\uD800-\uDFFF]/gu,'').normalize('NFC')
  .replace(/[\u0000-\u001f\u007f-\u009f]/gu,' ')
  .replace(/[\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu,'')
  .replace(/\s+/gu,' ');
 // Whitespace can become adjacent when redundant color codes disappear.
 const points=characters(bounded).filter((point,index,all)=>point.text!==' '||all[index-1]?.text!==' ');
 while(points[0]?.text===' ')points.shift();
 while(points.at(-1)?.text===' ')points.pop();
 const visible=points.slice(0,MAX_NAME_LENGTH);
 while(visible.at(-1)?.text===' ')visible.pop();
 if(!visible.length||!visible.some(p=>/[^\p{M}\u200c\u200d]/u.test(p.text)))return DEFAULT_PLAYER_NAME;
 let output='',active:NameColorCode='7';
 for(let i=0;i<visible.length;i++){
  const point=visible[i];
  // Retain a separator when dropping a redundant color would turn literal
  // caret + digit text into a new formatting token on the next parse.
  if(point.code!==active||(i===0&&point.explicit)||(output.endsWith('^')&&/^[0-9]$/.test(point.text))){output+='^'+point.code;active=point.code;}
  output+=point.text;
 }
 return output.normalize('NFC');
}

/** Older builds automatically saved the generic Player name. Only that exact
 * unversioned value is migrated; a newly chosen Player or any color code stays. */
export function restorePlayerNamePreference(input:unknown,version:unknown):string {
 const current=typeof version==='number'&&Number.isSafeInteger(version)&&version>=PLAYER_NAME_PREFERENCE_VERSION;
 return input==='Player'&&!current?DEFAULT_PLAYER_NAME:sanitizePlayerName(input);
}

/** Consecutive text retains the last valid color; unknown caret sequences are literal. */
export function parsePlayerName(name:string):NameSegment[]{
 const segments:NameSegment[]=[];
 for(const point of characters(sanitizePlayerName(name))){
  const last=segments.at(-1);
  if(last?.code===point.code)last.text+=point.text;
  else segments.push({text:point.text,code:point.code});
 }
 return segments;
}

export function plainPlayerName(name:string):string{return parsePlayerName(name).map(segment=>segment.text).join('');}

const escapeHTML=(text:string)=>text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));

/** Safe only as HTML element content: the style value comes exclusively from NAME_COLORS. */
export function playerNameHTML(name:string):string {
 return parsePlayerName(name).map(segment=>`<span style="color:${NAME_COLORS[segment.code]}">${escapeHTML(segment.text)}</span>`).join('');
}
