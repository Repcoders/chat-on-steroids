// Production renderer and real Chromium input; synthetic conversations only.
// Bulk select: Ctrl/Cmd-click and Shift-click pick several sidebar chats, a bar counts them, and its menu
// (or a picked row's) pins, marks read, blocks and removes all of them; Remove asks with the count first.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'chat-bulk-select'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
// Pins and read state are saved preferences: every run starts from an empty profile.
fs.rmSync(path.join(output, 'profile'), { recursive: true, force: true });
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const mac = process.platform === 'darwin';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
 const old=window.api,f=composerFixture,ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
 f.summary.title='Write a haiku about snow';
 f.summary.updatedAt=Date.now()-3*3600000; f.summary.lastToolCallAt=null; f.summary.activityExpiresAt=null;
 const titles=['Fix the flaky bridge test','Plan the release notes','Review the dashboard layout','Sketch the onboarding copy','Tidy the build scripts','Draft the changelog'];
 window.others=titles.map((title,n)=>({...f.summary,id:'chat-'+(n+1),title,conversationId:'conversation-'+(n+1),chatIds:['conversation-'+(n+1)],
  updatedAt:f.summary.updatedAt-(n+1)*60000,lastTurnOutcome:'completed',lastTurnEndAt:null}));
 // Two chats finish after the read baseline: they show as unread.
 window.others[1].lastTurnEndAt=Date.now()+60000; window.others[2].lastTurnEndAt=Date.now()+60000;
 window.blocked=new Set(); window.deleted=[]; window.questions=[];
 window.confirm=question=>{window.questions.push(question);return true;};
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'en',theme:'dark'};return r;},
  listSessions:()=>ok({sessions:[{...f.summary,events:f.events.length},...window.others].filter(o=>!window.deleted.includes(o.id)),activeId:null,pressure:[],blocked:[...window.blocked],trusted:[]}),
  setSessionBlocked:(id,blocked)=>{const row=[f.summary,...window.others].find(o=>o.id===id);if(row){if(blocked)window.blocked.add(row.conversationId);else window.blocked.delete(row.conversationId);}return ok([...window.blocked]);},
  deleteSession:id=>{window.deleted.push(id);return ok(true);}
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), cacheDir:path.join(output,'vite'), logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'chat-bulk-select-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/timeline-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/timeline-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1280,height:800,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(40);}throw new Error('Timed out: '+expression);};
  const settle=async()=>{await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`);await pause(180);};
  const capture=async name=>{await settle();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  const row=id=>`document.querySelector('#sessionList .sess[data-id="${id}"]')`;
  const picked=()=>js(`[...document.querySelectorAll('#sessionList .sess.is-picked')].map(r=>r.dataset.id)`);
  const order=()=>js(`[...document.querySelectorAll('#sessionList .sess[data-id]')].map(r=>r.dataset.id)`);
  const bar=()=>js(`document.querySelector('#sidebarSelection .sidebar-selection-count')?.textContent ?? null`);
  // A real click on the row's title, with the platform's modifier held.
  const click=async (id,modifiers=[])=>{
    const at=await js(`(()=>{const r=${row(id)}.querySelector('.sess-top b').getBoundingClientRect();return {x:Math.round(r.left+20),y:Math.round(r.top+r.height/2)}})()`);
    for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,...at,button:'left',clickCount:1,modifiers});
    await settle();
  };
  const ctrl=[mac?'meta':'control'];
  const items=()=>js(`[...document.querySelectorAll('.row-menu [data-row-action]')].map(b=>b.dataset.rowAction)`);
  const choose=async action=>{await js(`document.querySelector('.row-menu [data-row-action="${action}"]').click()`);await settle();};
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`!!${row('chat-6')}?.querySelector('.row-menu-button')`);
  win.show(); win.focus(); win.webContents.focus(); await pause(100);
  const before=await order();
  assert.equal(before.length,7,'Seven chats: '+JSON.stringify(before));
  assert.equal(await bar(),null,'No bar before anything is picked');
  await capture('1-before.png');

  // With one chat open, Ctrl/Cmd-click picks four more (the open one comes along) without opening them.
  await click('chat-1');
  await until(`${row('chat-1')}.classList.contains('is-sel')`);
  for (const id of ['chat-2','chat-3','chat-4','chat-5']) await click(id,ctrl);
  assert.deepEqual(await picked(),['chat-1','chat-2','chat-3','chat-4','chat-5']);
  assert.equal(await bar(),'5 chats selected');
  assert.equal(await js(`document.querySelector('#sessionList .sess.is-sel')?.dataset.id ?? null`),'chat-1','Picking opens no chat');
  // A screen reader hears which rows are picked, not only how many.
  assert.deepEqual(await js(`[...document.querySelectorAll('#sessionList .sess-top .sr-only')].map(s=>s.closest('.sess').dataset.id+':'+s.textContent)`),
    ['chat-1','chat-2','chat-3','chat-4','chat-5'].map(id=>id+':Selected'));
  // Ctrl/Cmd-click on a picked chat lets it go again.
  await click('chat-5',ctrl); await click('chat-5',ctrl);
  assert.equal(await bar(),'5 chats selected');
  await capture('2-picked.png');

  // The bar's menu: Pin all pins all five, and they lead the list.
  await js(`document.querySelector('#sidebarSelection .row-menu-button').click()`);
  await until(`!!document.querySelector('.row-menu [data-row-action="pin"]')`);
  assert.deepEqual(await items(),['pin','read','block','remove']);
  assert.equal(await js(`document.querySelector('.row-menu [data-row-action="pin"]').textContent`),'Pin all');
  await capture('3-menu.png');
  await choose('pin');
  assert.equal(await js(`document.querySelectorAll('#sessionList .sess.is-pinned').length`),5);
  assert.deepEqual((await order()).slice(0,5).sort(),['chat-1','chat-2','chat-3','chat-4','chat-5']);
  assert.deepEqual((await picked()).sort(),['chat-1','chat-2','chat-3','chat-4','chat-5'],'The chats stay picked after an action');
  // Mark all as read clears the two unread marks.
  assert.equal(await js(`document.querySelectorAll('#sessionList .session-status.is-unseen').length`),2);
  await js(`document.querySelector('#sidebarSelection .row-menu-button').click()`);
  await until(`!!document.querySelector('.row-menu [data-row-action="read"]')`);
  await choose('read');
  assert.equal(await js(`document.querySelectorAll('#sessionList .session-status.is-unseen').length`),0);
  await capture('4-pinned.png');

  // A plain click opens one chat and lets the picked ones go.
  await click('chat-6');
  await until(`${row('chat-6')}.classList.contains('is-sel')`);
  assert.equal(await bar(),null);
  assert.deepEqual(await picked(),[]);
  // Shift-click picks the run from the open chat; a picked row's own menu acts on all of them.
  await click('chat-3',['shift']);
  const shown=await order(); const run=shown.slice(Math.min(shown.indexOf('chat-6'),shown.indexOf('chat-3')),Math.max(shown.indexOf('chat-6'),shown.indexOf('chat-3'))+1);
  assert.deepEqual(await picked(),run,'Shift-click picks the run: '+JSON.stringify(shown));
  await click('chat-6',ctrl);
  assert.equal(await bar(),`${run.length-1} chats selected`);
  const toRemove=await picked();
  await js(`${row(toRemove[0])}.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:200}))`);
  await until(`!!document.querySelector('.row-menu [data-row-action="block"]')`);
  assert.equal(await js(`document.querySelector('.row-menu').getAttribute('aria-label')`),`${toRemove.length} chats selected`);
  await choose('block');
  await until(`window.blocked.size===${toRemove.length}`);
  await js(`${row(toRemove[0])}.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:200}))`);
  await until(`!!document.querySelector('.row-menu [data-row-action="remove"]')`);
  assert.equal(await js(`document.querySelector('.row-menu [data-row-action="block"]').textContent`),'Release all');
  await capture('5-picked-menu.png');
  await choose('remove');
  await until(`window.deleted.length===${toRemove.length}`);
  assert.deepEqual(await js('window.questions'),[`Remove ${toRemove.length} chats from the app? Their saved histories are deleted. The chats stay in ChatGPT.`]);
  await until(`${toRemove.map(id=>`!${row(id)}`).join('&&')}`);
  assert.deepEqual(await js('window.deleted'),toRemove);
  assert.equal(await bar(),null,'Nothing is picked after Remove');
  await capture('6-removed.png');
  console.log(JSON.stringify({ removed: toRemove, question: (await js('window.questions'))[0] }));
  assert.deepEqual(errors,[]);
  console.log('PASS: Ctrl/Shift-click picks several chats, the bar counts them, and Pin, Mark as read, Block and Remove reach all of them');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await server?.close();app.exit(1);});
