export const DEFAULT_TOUCH_SENSITIVITY=4;
export const MIN_TOUCH_SENSITIVITY=.5,MAX_TOUCH_SENSITIVITY=6;
export const TOUCH_SENSITIVITY_PREFERENCE_VERSION=1;

/** Older releases saved 1 even when the touch setting was never adjusted. */
export function restoreTouchSensitivityPreference(value:unknown,version:unknown){
 if(typeof value!=='number'||!Number.isFinite(value))return DEFAULT_TOUCH_SENSITIVITY;
 const current=typeof version==='number'&&version>=TOUCH_SENSITIVITY_PREFERENCE_VERSION;
 if(!current&&value===1)return DEFAULT_TOUCH_SENSITIVITY;
 return Math.max(MIN_TOUCH_SENSITIVITY,Math.min(MAX_TOUCH_SENSITIVITY,value));
}
