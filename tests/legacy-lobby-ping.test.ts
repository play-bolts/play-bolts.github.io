import test from 'node:test';
import assert from 'node:assert/strict';
import {Game} from '../src/engine';
import {NetworkClient} from '../src/network';

test('legacy lobby pings retain each browser request RTT without a nonexistent ping socket',async()=>{
 let now=10,sockets=0;
 const client=new NetworkClient(new Game(),{origin:'https://legacy.example.test',now:()=>now,fetch:async()=>{now=63;return new Response(JSON.stringify({lobbies:[{id:'a',name:'Legacy',players:2,capacity:6,phase:'playing'}]}));},socket:()=>{sockets++;throw Error('Legacy server has no ping socket');}});
 const rows=await client.lobbies();assert.equal(rows[0].ping,53);
 assert.equal((await client.measureLobbies(rows))[0].ping,53);assert.equal(sockets,0);
});
