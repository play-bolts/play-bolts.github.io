import test from 'node:test';
import assert from 'node:assert/strict';
import {PointerCapture} from '../src/pointerCapture.ts';

function deferred(){let reject:(reason?:unknown)=>void=()=>{};const promise=new Promise<void>((_resolve,no)=>{reject=no;});return {promise,reject};}
function fixture(){
 const requests:ReturnType<typeof deferred>[]=[];
 const canvas={requestPointerLock:():Promise<void>|void=>{const request=deferred();requests.push(request);return request.promise;}};
 const document={pointerLockElement:null as unknown,exits:0,exitPointerLock(){this.exits++;this.pointerLockElement=null;}};
 const capture=new PointerCapture(canvas,document);
 const grant=()=>{document.pointerLockElement=canvas;return capture.changed();};
 return {canvas,document,capture,requests,grant};
}
const flush=()=>new Promise<void>(resolve=>queueMicrotask(resolve));

test('a failed asynchronous capture can be retried by the next click',async()=>{
 const {capture,requests,grant}=fixture();capture.request();requests[0].reject(new Error('User activation required'));await flush();
 assert.equal(capture.fallback,true);assert.equal(capture.locked,false);
 capture.request();assert.equal(requests.length,2);assert.equal(grant(),false);assert.equal(capture.locked,true);assert.equal(capture.fallback,false);
});
test('event-only browsers recover after pointerlockerror and synchronous failures',()=>{
 const {capture,canvas,grant}=fixture();let attempts=0;canvas.requestPointerLock=()=>{attempts++;};
 capture.request();capture.error();assert.equal(capture.fallback,true);capture.request();assert.equal(attempts,2);grant();assert.equal(capture.fallback,false);
 const throwing=fixture();throwing.canvas.requestPointerLock=()=>{throw Error('Browser denied capture');};throwing.capture.request();assert.equal(throwing.capture.fallback,true);
 throwing.canvas.requestPointerLock=()=>{};throwing.capture.request();throwing.grant();assert.equal(throwing.capture.locked,true);assert.equal(throwing.capture.fallback,false);
});
test('a late rejection or error cannot undo a newer successful capture',async()=>{
 const {capture,requests,grant}=fixture();capture.request();capture.request();grant();
 requests[0].reject(Error('Stale request'));requests[1].reject(Error('Out-of-order rejection'));capture.error();await flush();
 assert.equal(capture.locked,true);assert.equal(capture.fallback,false);
});
test('opening chat, a menu, or losing focus cancels pending capture and releases a late grant',async()=>{
 const {capture,document,requests,grant}=fixture();capture.request();capture.release();
 assert.equal(grant(),false);assert.equal(document.exits,1);assert.equal(capture.locked,false);assert.equal(capture.changed(),false);
 requests[0].reject(Error('Cancelled'));capture.error();await flush();assert.equal(capture.fallback,false);
 capture.request();grant();assert.equal(capture.locked,true,'a later user gesture can capture again');
});
test('only an unexpected loss of our own canvas capture requests a pause',()=>{
 const {capture,document,grant}=fixture();document.pointerLockElement={};assert.equal(capture.locked,false);assert.equal(capture.changed(),false);
 document.pointerLockElement=null;capture.request();grant();document.pointerLockElement=null;
 assert.equal(capture.changed(),true);assert.equal(capture.changed(),false,'duplicate events cannot toggle pause twice');
 capture.request();grant();capture.release();assert.equal(capture.changed(),false,'intentional release is already handled by its caller');
});
test('a queued unlock event cannot pause a fresh click that is recapturing the mouse',()=>{
 const {capture,document,grant}=fixture();capture.request();grant();document.pointerLockElement=null;
 capture.request();assert.equal(capture.changed(),false);grant();assert.equal(capture.locked,true);
});
