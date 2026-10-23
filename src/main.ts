/// <reference types="vite/client" />
import './style.css';
import {UI} from './ui';
import {CommunityClient} from './community';
import {startVisitorTracking} from './visitors';
import {startGoogleAnalytics} from './analytics';
import {readLaunchAction} from './launch';
import {startBackgroundGame} from './startup';

const visitorTracker=startVisitorTracking();
const analytics=startGoogleAnalytics();
const ui=new UI(),community=new CommunityClient();
let leaderboardBusy=false;
ui.feedbackSend=(message,email)=>community.feedback(message,email);
ui.leaderboardLoad=()=>{
 if(leaderboardBusy)return;leaderboardBusy=true;ui.setLeaderboardStatus('Loading…',true);
 void community.leaderboard().then(data=>ui.setLeaderboard(data)).catch(()=>ui.setLeaderboardStatus('Unable to load leaderboard.')).finally(()=>{leaderboardBusy=false;});
};
// UI/settings do not import Three.js. Let the menu paint before downloading and
// evaluating the runtime, then prepare graphics while visitors choose a team.
export const gameReady=startBackgroundGame(ui,async()=>{
 const {initializeGame}=await import('./gameRuntime');
 return initializeGame(ui,visitorTracker,analytics,community);
});
void gameReady.catch(()=>{/* The preparation path presents a retryable error. */});

const launchAction=readLaunchAction(location.search);
if(launchAction){
 const address=new URL(location.href);address.searchParams.delete('launch');history.replaceState(null,'',address);
 if(launchAction==='singleplayer')ui.start();else if(launchAction==='multiplayer')ui.multiplayer();else ui.openModal(launchAction==='options'?'settings':'controls');
}
