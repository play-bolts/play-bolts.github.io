import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_PLAYER_NAME,PLAYER_NAME_PREFERENCE_VERSION,MAX_NAME_LENGTH,MAX_NAME_RAW_LENGTH,NAME_COLORS,parsePlayerName,plainPlayerName,playerNameHTML,sanitizePlayerName,restorePlayerNamePreference} from '../src/names.ts';
import {Game} from '../src/engine.ts';

test('unnamed players default to Unknown Soldier without rewriting saved custom names',()=>{
 assert.equal(DEFAULT_PLAYER_NAME,'Unknown Soldier');
 assert.equal(sanitizePlayerName(undefined),'Unknown Soldier');
 assert.equal(sanitizePlayerName(' ^3^9 '),'Unknown Soldier');
 for(const savedName of ['Player','Chris','^7Chri^9s','^2Unknown Soldier'])assert.equal(sanitizePlayerName(savedName),savedName);
 const game=new Game();game.start('british','recruit');assert.equal(game.player.name,'Unknown Soldier');
});

test('legacy generic preferences migrate once while intentional names and colors survive',()=>{
 for(const version of [undefined,null,0,'1',NaN])assert.equal(restorePlayerNamePreference('Player',version),'Unknown Soldier');
 for(const name of ['Chris','player','^7Player','^1Player','^7Chri^9s','^2Unknown Soldier'])assert.equal(restorePlayerNamePreference(name,undefined),name);
 // The version written with every new name choice distinguishes an explicit
 // Player from the otherwise identical default stored by an older release.
 const saved=JSON.parse(JSON.stringify({playerName:'Player',playerNameVersion:PLAYER_NAME_PREFERENCE_VERSION}));
 assert.equal(restorePlayerNamePreference(saved.playerName,saved.playerNameVersion),'Player');
 assert.equal(restorePlayerNamePreference('Player',PLAYER_NAME_PREFERENCE_VERSION+1),'Player');
 for(const name of [undefined,null,'','^3^9'])assert.equal(restorePlayerNamePreference(name,PLAYER_NAME_PREFERENCE_VERSION),'Unknown Soldier');
});

test('classic name colors persist until the next code, including the requested example',()=>{
 assert.equal(sanitizePlayerName('^7Chri^9s'),'^7Chri^9s');
 assert.deepEqual(parsePlayerName('^7Chri^9s'),[{text:'Chri',code:'7'},{text:'s',code:'9'}]);
 assert.deepEqual(parsePlayerName('^1Red text^2Green^7 white'),[{text:'Red text',code:'1'},{text:'Green',code:'2'},{text:' white',code:'7'}]);
 assert.equal(plainPlayerName('^7Chri^9s'),'Chris');
 assert.equal(playerNameHTML('^7Chri^9s'),'<span style="color:#ffffff">Chri</span><span style="color:#808080">s</span>');
});

test('all ten codes render only their fixed palette values',()=>{
 for(let i=0;i<=9;i++){
  const code=String(i) as keyof typeof NAME_COLORS;
  assert.equal(playerNameHTML(`^${code}Name`),`<span style="color:${NAME_COLORS[code]}">Name</span>`);
 }
 assert.equal(NAME_COLORS['0'],'#000000');assert.equal(NAME_COLORS['7'],'#ffffff');assert.equal(NAME_COLORS['9'],'#808080');
});

test('HTML and attribute-shaped names are escaped rather than executed',()=>{
 assert.equal(playerNameHTML('^1<img src=x onerror=1>'),'<span style="color:#ff0000">&lt;img src=x onerror=1&gt;</span>');
 assert.equal(playerNameHTML(`^2<&>"'`),'<span style="color:#00ff00">&lt;&amp;&gt;&quot;&#39;</span>');
 const escaped=playerNameHTML('^9</span><svg onload=1>');
 assert.equal((escaped.match(/<span /g)??[]).length,1);
 assert.equal((escaped.match(/<\/span>/g)??[]).length,1);
 assert.ok(!escaped.includes('<svg'));
});

test('unknown or trailing caret sequences remain literal, and color state stays local',()=>{
 assert.equal(plainPlayerName('Name^x ^'),'Name^x ^');
 assert.deepEqual(parsePlayerName('^^1Red'),[{text:'^',code:'7'},{text:'Red',code:'1'}]);
 assert.equal(plainPlayerName('^1^^11'),'^1');
 assert.equal(sanitizePlayerName(sanitizePlayerName('^1^^11')),sanitizePlayerName('^1^^11'));
 assert.deepEqual(parsePlayerName('^1^2Green^9'),[{text:'Green',code:'2'}]);
 playerNameHTML('^1Red');
 assert.deepEqual(parsePlayerName('Plain'),[{text:'Plain',code:'7'}]);
});

test('names trim visible whitespace, reject controls, and fall back when no visible name remains',()=>{
 assert.equal(sanitizePlayerName('  ^1  Red\t Name \n '),'^1Red Name');
 assert.equal(sanitizePlayerName('A ^7 B'),'A B');
 assert.equal(sanitizePlayerName('A^7\u0301'),'Á');
 assert.equal(sanitizePlayerName('A\u202eB\u2066C\u0000D'),'ABC D');
 for(const input of [undefined,null,55,{},'', '   ', '^1^7^9', '\u200b\u200d'])assert.equal(sanitizePlayerName(input),DEFAULT_PLAYER_NAME);
});

test('length limits ignore valid color codes and do not split Unicode code points',()=>{
 const colored=Array.from({length:60},(_,i)=>`^${i%10}A`).join('');
 assert.equal(Array.from(plainPlayerName(sanitizePlayerName(colored))).length,MAX_NAME_LENGTH);
 const emoji=Array.from({length:60},(_,i)=>`^${i%10}🙂`).join('');
 const sanitized=sanitizePlayerName(emoji);
 assert.equal(Array.from(plainPlayerName(sanitized)).length,MAX_NAME_LENGTH);
 assert.ok(sanitized.length<=MAX_NAME_RAW_LENGTH);
 assert.ok(!/[\uD800-\uDFFF]/u.test(sanitized));
 assert.equal(sanitizePlayerName('^1'.repeat(10000)),DEFAULT_PLAYER_NAME);
 assert.equal(sanitizePlayerName('Cafe\u0301'),'Café');
});

test('game names normalize at start, persist on respawn, and update without changing bots',()=>{
 const game=new Game();game.start('british','recruit','^7Chri^9s');
 assert.equal(game.player.name,'^7Chri^9s');
 const botNames=game.actors.slice(1).map(actor=>actor.name);
 game.spawn(game.player);assert.equal(game.player.name,'^7Chri^9s');
 assert.equal(game.setPlayerName('  ^2New Name '),'^2New Name');
 assert.equal(game.player.name,'^2New Name');
 assert.deepEqual(game.actors.slice(1).map(actor=>actor.name),botNames);
 game.start('german','regular');assert.equal(game.player.name,DEFAULT_PLAYER_NAME);
 assert.equal(game.setPlayerName('^1'),DEFAULT_PLAYER_NAME);
});
