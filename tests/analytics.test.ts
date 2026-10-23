import test from 'node:test';
import assert from 'node:assert/strict';
import {installGoogleAnalytics,type AnalyticsOptions} from '../src/analytics.ts';
import {visitorTrackingAllowed} from '../src/visitors.ts';

function fixture(overrides:Partial<AnalyticsOptions>={}){
 const tags:unknown[][]=[],scripts:string[]=[];let disabled=false;
 const options:AnalyticsOptions={measurementId:'G-TEST123456',permitted:()=>true,pageUrl:'https://play-bolts.github.io/?name=Private&launch=singleplayer#token',
  tag:(...args)=>{tags.push(args);},loadScript:url=>{scripts.push(url);},disable:()=>{disabled=true;},...overrides};
 return{options,tags,scripts,disabled:()=>disabled};
}

test('GA loads asynchronously with one pageview configuration and sanitized page context',()=>{
 const f=fixture();assert.ok(installGoogleAnalytics(f.options));
 assert.deepEqual(f.scripts,['https://www.googletagmanager.com/gtag/js?id=G-TEST123456']);
 assert.equal(f.tags.length,2);assert.equal(f.tags[0][0],'js');assert.ok(f.tags[0][1] instanceof Date);
 assert.deepEqual(f.tags[1],['config','G-TEST123456',{page_location:'https://play-bolts.github.io/',page_referrer:'',page_title:'Bolts',allow_google_signals:false,allow_ad_personalization_signals:false}]);
});

test('unconfigured, malformed, opted-out and non-production GA never queues a tag or loads a script',()=>{
 for(const measurementId of [undefined,'','G-','UA-1234-1','G-TEST&leak=1','G-test123456']){
  const f=fixture({measurementId});assert.equal(installGoogleAnalytics(f.options),null);assert.deepEqual(f.tags,[]);assert.deepEqual(f.scripts,[]);
 }
 for(const settings of [{production:false},{production:true,globalPrivacyControl:true},{production:true,doNotTrack:'1'},{production:true,search:'?qa=1'},{production:true,search:'?visits=0'}]){
  const f=fixture({permitted:()=>visitorTrackingAllowed({pathname:'/',search:'',...settings})});
  assert.equal(installGoogleAnalytics(f.options),null);assert.deepEqual(f.tags,[]);assert.deepEqual(f.scripts,[]);
 }
});

test('GA single-player events have bounded fields and honor later privacy opt-outs',()=>{
 let allowed=true;const f=fixture({permitted:()=>allowed}),tracker=installGoogleAnalytics(f.options)!;
 tracker.singlePlayerEvent('single_player_start');tracker.singlePlayerEvent('single_player_stop','round_end');
 const context={page_location:'https://play-bolts.github.io/',page_referrer:'',page_title:'Bolts',send_to:'G-TEST123456'};
 assert.deepEqual(f.tags.slice(2),[['event','single_player_start',context],['event','single_player_stop',{...context,reason:'round_end'}]]);
 allowed=false;tracker.singlePlayerEvent('single_player_start');assert.equal(f.tags.length,4);assert.equal(f.disabled(),true);
});

test('script/tag failures never escape analytics initialization or gameplay callbacks',()=>{
 const broken=fixture({loadScript:()=>{throw new Error('Blocked');}});assert.equal(installGoogleAnalytics(broken.options),null);
 const f=fixture(),tracker=installGoogleAnalytics(f.options)!;f.options.tag=()=>{throw new Error('Blocked');};
 assert.doesNotThrow(()=>tracker.singlePlayerEvent('single_player_stop','quit'));
});
