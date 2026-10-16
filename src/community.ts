/// <reference types="vite/client" />
export const FEEDBACK_MESSAGE_LIMIT=2000;
export const FEEDBACK_EMAIL_LIMIT=254;
export interface FeedbackRequest {message:string;email?:string}
export interface LeaderboardEntry {name:string;kills:number;deaths:number}
export interface Leaderboard {allTime:LeaderboardEntry[];last24Hours:LeaderboardEntry[]}
export type LeaderboardPeriod=keyof Leaderboard;

/** Use the same Unicode limit as the API, without silently losing a draft. */
export function validateFeedback(message:string,email:string):FeedbackRequest {
 const text=message.trim(),address=email.trim();
 if(!text)throw new Error('Enter your feedback.');
 if(Array.from(text).length>FEEDBACK_MESSAGE_LIMIT)throw new Error(`Keep feedback to ${FEEDBACK_MESSAGE_LIMIT} characters.`);
 if(address&&(Array.from(address).length>FEEDBACK_EMAIL_LIMIT||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)))throw new Error('Enter a valid email address.');
 return{message:text,...(address?{email:address}:{})};
}

const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
function leaderboardEntries(value:unknown):LeaderboardEntry[]{
 if(!Array.isArray(value))throw new Error('Unable to load leaderboard.');
 return value.map(row=>{
  if(!row||typeof row.name!=='string'||!row.name.trim()||row.name.length>128||!count(row.kills)||!count(row.deaths))throw new Error('Unable to load leaderboard.');
  return{name:row.name,kills:row.kills,deaths:row.deaths};
 });
}

export class CommunityClient {
 constructor(private origin=import.meta.env?.VITE_MULTIPLAYER_URL??'',private fetcher:typeof fetch=globalThis.fetch.bind(globalThis)){}
 private endpoint(path:string){
  if(!this.origin)throw new Error('Online services unavailable.');
  const origin=new URL(this.origin);
  if(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))throw new Error('Online services require a secure connection.');
  return new URL(path,origin).href;
 }
 async status():Promise<number>{
  const response=await this.fetcher(this.endpoint('/api/status'),{cache:'no-store',signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error('Online count unavailable.');
  const body=await response.json();if(!body||!count(body.online))throw new Error('Online count unavailable.');return body.online;
 }
 async leaderboard():Promise<Leaderboard>{
  const response=await this.fetcher(this.endpoint('/api/leaderboard'),{cache:'no-store',signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error('Unable to load leaderboard.');
  const body=await response.json();return{allTime:leaderboardEntries(body?.allTime),last24Hours:leaderboardEntries(body?.last24Hours)};
 }
 async feedback(message:string,email:string):Promise<void>{
  const body=validateFeedback(message,email);
  let response:Response;
  try{response=await this.fetcher(this.endpoint('/api/feedback'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});}
  catch{throw new Error('Unable to send feedback. Please try again.');}
  if(!response.ok)throw new Error(response.status===429?'Please wait before sending more feedback.':'Unable to send feedback. Please try again.');
  const result=await response.json();if(typeof result?.id!=='string'||!result.id)throw new Error('Unable to confirm feedback. Please try again.');
 }
}
