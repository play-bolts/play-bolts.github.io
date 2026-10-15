export type LaunchAction='singleplayer'|'multiplayer'|'options'|'controls';
const actions:readonly string[]=['singleplayer','multiplayer','options','controls'];
/** Only local menu actions are accepted; the query cannot redirect elsewhere. */
export function readLaunchAction(search:string):LaunchAction|null {
 const action=new URLSearchParams(search).get('launch');
 return action&&actions.includes(action)?action as LaunchAction:null;
}
