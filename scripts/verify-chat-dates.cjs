// Production renderer and real Chromium layout/input; synthetic conversations only.
// Date labels in the Chats list: Today, Yesterday, Previous 7 days and months above the unpinned chats,
// none above pinned ones; dragging inside a group keeps them, a list sorted out of date order has none.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'chat-dates'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
// Order and pins are saved preferences: every run starts from an empty profile.
fs.rmSync(path.join(output, 'profile'), { recursive: true, force: true });
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
// Times on the local calendar, so the groups never depend on the hour the check runs.
const fixture = `(() => {
 const old=window.api,f=composerFixture,ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
 const d=new Date(),day=offset=>new Date(d.getFullYear(),d.getMonth(),d.getDate()-offset).getTime();
 const times=[day(0)+2*60000,day(0)+60000,day(1),day(3),new Date(d.getFullYear(),d.getMonth()-2,15).getTime(),new Date(d.getFullYear()-1,d.getMonth(),15).getTime()];
 const titles=['Fix the flaky bridge test','Plan the release notes','Review the dashboard layout','Rename the config keys','Draft the onboarding email','Sketch the logo'];
 f.summary.lastToolCallAt=null; f.summary.activityExpiresAt=null;
 const chats=times.map((updatedAt,n)=>({...f.summary,id:'chat-'+(n+1),title:titles[n],conversationId:'conversation-'+(n+1),chatIds:['conversation-'+(n+1)],startedAt:updatedAt,updatedAt}));
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'en'};return r;},
  listSessions:()=>ok({sessions:chats,activeId:null,pressure:[],blocked:[],trusted:[]})
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), cacheDir:path.join(output,'vite'), logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'chat-dates-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/timeline-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/timeline-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1280,height:800,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(40);}throw new Error('Timed out: '+expression);};
  const settle=async()=>{await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`);await pause(180);};
  const capture=async name=>{await settle();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  // The Chats list as drawn: a label as "# <words>", a chat as its id.
  const drawn=()=>js(`[...document.querySelectorAll('#chatList > *')].map(n=>n.classList.contains('sess-date')?'# '+n.textContent:n.dataset.id)`);
  const row=id=>`document.querySelector('#chatList .sess[data-id="${id}"]')`;
  // Alt+Down on a chat's handle moves it one place down in its own list.
  const moveDown=async id=>{await js(`(()=>{const h=${row(id)}.querySelector('[data-sort-handle]');h.focus();h.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',altKey:true,bubbles:true}))})()`);await settle();};
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`!!${row('chat-6')}`);
  win.show(); await settle();
  // Two months back names its year only when it falls in last year (in January and February).
  const [monthLabel, older] = await js(`(()=>{const d=new Date(),two=new Date(d.getFullYear(),d.getMonth()-2,15),f=o=>new Intl.DateTimeFormat('en',o).format;
    return [f(two.getFullYear()===d.getFullYear()?{month:'long'}:{month:'long',year:'numeric'})(two),f({month:'long',year:'numeric'})(new Date(d.getFullYear()-1,d.getMonth(),15))];})()`);
  assert.deepEqual(await drawn(), ['# Today','chat-1','chat-2','# Yesterday','chat-3','# Previous 7 days','chat-4',`# ${monthLabel}`,'chat-5',`# ${older}`,'chat-6']);
  // Plain text: not a row, not focusable, not something a chat can be dropped on.
  assert.equal(await js(`[...document.querySelectorAll('#chatList .sess-date')].some(n=>n.tabIndex>=0||n.hasAttribute('data-sort-scope')||n.classList.contains('sess'))`),false);
  await capture('dates.png');
  // A pinned chat leads the list with no label; the labels stay with the unpinned chats.
  await js(`${row('chat-3')}.querySelector('.row-menu-button').click()`);
  await until(`!!document.querySelector('.row-menu [data-row-action="pin"]')`);
  await js(`document.querySelector('.row-menu [data-row-action="pin"]').click()`); await settle();
  assert.deepEqual(await drawn(), ['chat-3','# Today','chat-1','chat-2','# Previous 7 days','chat-4',`# ${monthLabel}`,'chat-5',`# ${older}`,'chat-6']);

  // Dragging a chat inside its group keeps every label.
  await moveDown('chat-1');
  assert.deepEqual((await drawn()).slice(1,4), ['# Today','chat-2','chat-1']);
  assert.equal((await drawn()).filter(n=>n.startsWith('# ')).length, 4);
  // Moved below an older chat, the list is no longer in date order: no label would be true, so none is drawn.
  await moveDown('chat-1');
  assert.deepEqual(await drawn(), ['chat-3','chat-2','chat-4','chat-1','chat-5','chat-6']);
  await capture('hand-sorted.png');
  assert.deepEqual(errors,[]);
  console.log('PASS: date labels sit above the unpinned chats in date order, never above pinned ones, and leave a hand-sorted list alone');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await server?.close();app.exit(1);});
