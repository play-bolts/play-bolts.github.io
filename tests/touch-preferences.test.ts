import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_TOUCH_SENSITIVITY,TOUCH_SENSITIVITY_PREFERENCE_VERSION,restoreTouchSensitivityPreference} from '../src/touchPreferences.ts';

test('new players and the old untouched touch default get a usable thumb-swipe speed',()=>{
 for(const saved of [undefined,null,NaN,Infinity,'1'])assert.equal(restoreTouchSensitivityPreference(saved,undefined),DEFAULT_TOUCH_SENSITIVITY);
 assert.equal(restoreTouchSensitivityPreference(1,undefined),DEFAULT_TOUCH_SENSITIVITY);
 // The game's .0018 rad/pixel look scale should turn roughly a quarter turn
 // with a normal 200-pixel swipe, instead of the old default's 21 degrees.
 const degrees=200*.0018*DEFAULT_TOUCH_SENSITIVITY*180/Math.PI;
 assert.ok(degrees>75&&degrees<95);
});

test('custom sensitivity survives migration, including deliberately restoring the old speed',()=>{
 for(const value of [.5,.8,1.2,1.7,2])assert.equal(restoreTouchSensitivityPreference(value,undefined),value);
 const saved=JSON.parse(JSON.stringify({touchSensitivity:1,touchSensitivityVersion:TOUCH_SENSITIVITY_PREFERENCE_VERSION}));
 assert.equal(restoreTouchSensitivityPreference(saved.touchSensitivity,saved.touchSensitivityVersion),1);
 assert.equal(restoreTouchSensitivityPreference(1,TOUCH_SENSITIVITY_PREFERENCE_VERSION+1),1);
 assert.equal(restoreTouchSensitivityPreference(5.5,TOUCH_SENSITIVITY_PREFERENCE_VERSION),5.5);
 assert.equal(restoreTouchSensitivityPreference(-1,undefined),.5);
 assert.equal(restoreTouchSensitivityPreference(100,undefined),6);
});
