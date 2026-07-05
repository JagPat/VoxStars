/* End-to-end API test. Assumes the server is running at BASE with coach PIN PIN. */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const PIN  = process.env.PIN  || '2626';
let pass=0, fail=0;
const ok=(c,m)=>{ c?(pass++,console.log('  PASS  '+m)):(fail++,console.log('  x FAIL '+m)); };
const J=r=>r.json();
async function get(p){ return fetch(BASE+p); }
async function send(method,p,body,pin){
  const h={'Content-Type':'application/json'}; if(pin)h['x-coach-pin']=pin;
  return fetch(BASE+p,{method,headers:h,body:body?JSON.stringify(body):undefined});
}

(async()=>{
  console.log('API E2E against',BASE);

  let r=await get('/api/health'); let d=await J(r);
  ok(r.status===200 && d.ok===true,'health ok');

  r=await get('/api/state'); d=await J(r);
  ok(d.players.length===15,'state returns 15 players');
  ok(d.settings.lineupSize===5,'default lineupSize 5');

  // player logs a game (open, no pin)
  r=await send('POST','/api/games',{no:99,score:170,strikes:5,spares:2,date:'2026-07-05'});
  d=await J(r); const ts=d.game && d.game.ts;
  ok(r.status===200 && d.ok && ts,'open game log accepted, ts issued');

  r=await get('/api/state'); d=await J(r);
  const p99=d.players.find(x=>x.no===99);
  ok(p99.games.length===1 && p99.games[0].score===170,'game persisted to player 99');
  ok(p99.games[0].verified===false,'new game starts unverified');

  // invalid score rejected
  r=await send('POST','/api/games',{no:99,score:999}); ok(r.status===400,'score >300 rejected');
  // unknown player rejected
  r=await send('POST','/api/games',{no:9999,score:100}); ok(r.status===404,'unknown player rejected');

  // coach action WITHOUT pin -> 401
  r=await send('PUT','/api/settings',{lineupSize:6}); ok(r.status===401,'coach action blocked without PIN');
  // coach action WITH wrong pin -> 401
  r=await send('PUT','/api/settings',{lineupSize:6},'0000'); ok(r.status===401,'wrong PIN blocked');
  // coach action WITH pin -> ok
  r=await send('PUT','/api/settings',{lineupSize:6,minFemales:2},PIN); d=await J(r);
  ok(r.status===200 && d.settings.lineupSize===6 && d.settings.minFemales===2,'settings update with PIN');

  // coach verify
  r=await send('POST',`/api/games/99/${ts}/verify`,null,PIN); d=await J(r);
  ok(r.status===200 && d.verified===true,'coach verified the game');

  // coach player flag
  r=await send('PUT','/api/players/149',{lockIn:true},PIN); d=await J(r);
  ok(r.status===200 && d.player.lockIn===true,'coach locked in player 149');

  // coach pin verify endpoint
  r=await send('POST','/api/coach/verify',{pin:PIN}); d=await J(r); ok(d.ok===true,'correct PIN verifies');
  r=await send('POST','/api/coach/verify',{pin:'nope'}); d=await J(r); ok(d.ok===false,'incorrect PIN fails');

  // coach delete game
  r=await send('DELETE',`/api/games/99/${ts}`,null,PIN); d=await J(r);
  ok(r.status===200 && d.removed===1,'coach deleted the game');

  // reset
  r=await send('POST','/api/reset',null,PIN); ok(r.status===200,'coach reset ok');
  r=await get('/api/state'); d=await J(r);
  ok(d.players.find(x=>x.no===99).games.length===0 && d.settings.lineupSize===5,'state reset to defaults');

  // frontend served
  r=await get('/'); const html=await r.text();
  ok(r.status===200 && /VOX STARS/.test(html) && /api\/state/.test(html),'index.html served & wired to API');

  console.log('\nRESULT:',pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})().catch(e=>{ console.log('ERROR',e.message); process.exit(1); });
