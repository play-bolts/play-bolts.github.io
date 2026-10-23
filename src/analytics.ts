/// <reference types="vite/client" />
import {visitorPrivacyOptOut,visitorTrackingAllowed,type VisitorPrivacy} from './visitors';

export type SinglePlayerStopReason='quit'|'page_exit'|'restart'|'round_end';
export type SinglePlayerEvent='single_player_start'|'single_player_stop';
type Tag=(...args:unknown[])=>void;
export interface AnalyticsOptions {
 measurementId:unknown;
 permitted:()=>boolean;
 pageUrl:string;
 tag:Tag;
 loadScript:(url:string)=>void;
 disable:()=>void;
}
export interface GoogleAnalytics {singlePlayerEvent(event:SinglePlayerEvent,reason?:SinglePlayerStopReason):void}

/** A public GA4 stream ID is required. Never send names, visitor/session IDs,
 * raw IPs, query parameters, or fragments as event properties. */
export function installGoogleAnalytics(options:AnalyticsOptions):GoogleAnalytics|null {
 try{
  if(typeof options.measurementId!=='string'||!/^G-[A-Z0-9]{4,}$/.test(options.measurementId)||!options.permitted())return null;
  const id=options.measurementId,url=new URL(options.pageUrl);
  if(!['http:','https:'].includes(url.protocol))return null;
  const context={page_location:url.origin+url.pathname,page_referrer:'',page_title:'Bolts'};
  options.tag('js',new Date());
  options.tag('config',id,{...context,allow_google_signals:false,allow_ad_personalization_signals:false});
  options.loadScript(`https://www.googletagmanager.com/gtag/js?id=${id}`);
  return{singlePlayerEvent(event,reason){
   try{
    if(!options.permitted()){options.disable();return;}
    options.tag('event',event,{...context,send_to:id,...(event==='single_player_stop'&&reason?{reason}:{})});
   }catch{/* Analytics must never interrupt a game. */}
  }};
 }catch{return null;}
}

let started=false;
/** Independent async script: never awaited by the menu or graphics loader. */
export function startGoogleAnalytics():GoogleAnalytics|null {
 if(started)return null;started=true;
 try{
  const nav=navigator as Navigator&{globalPrivacyControl?:boolean;msDoNotTrack?:string};
  const win=window as Window&{dataLayer?:unknown[];gtag?:Tag;doNotTrack?:string};
  const privacy=():VisitorPrivacy=>({globalPrivacyControl:nav.globalPrivacyControl,doNotTrack:nav.doNotTrack,windowDoNotTrack:win.doNotTrack,msDoNotTrack:nav.msDoNotTrack});
  const permitted=()=>visitorTrackingAllowed({production:import.meta.env?.PROD??false,pathname:location.pathname,search:location.search,...privacy()});
  const id=import.meta.env?.VITE_GA_MEASUREMENT_ID;
  const disable=()=>{if(typeof id==='string')Reflect.set(win,`ga-disable-${id}`,true);};
  const analytics=installGoogleAnalytics({measurementId:id,permitted,pageUrl:location.href,disable,
   tag(...args){
    win.dataLayer??=[];
    // gtag consumes Arguments objects, matching Google's standard snippet.
    win.gtag??=function(){win.dataLayer!.push(arguments);};
    win.gtag(...args);
   },
   loadScript(url){const script=document.createElement('script');script.async=true;script.src=url;script.referrerPolicy='no-referrer';document.head.append(script);},
  });
  if(analytics)document.addEventListener('visibilitychange',()=>{if(visitorPrivacyOptOut(privacy()))disable();});
  return analytics;
 }catch{return null;}
}
