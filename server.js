// ============================================================
// server.js — PhysicsFriends 一体化服务器
//
// 同时提供：
//   1. WebSocket 中继（联机房间）
//   2. 静态文件托管（WebGL 构建 → 浏览器直接玩）
//
// 目录结构：
//   /server.js
//   /public/             ← 放 WebGL 构建产物
//     index.html
//     Build/
//       PhysicsFriends.loader.js
//       PhysicsFriends.framework.js(.gz/.br)
//       PhysicsFriends.data(.gz/.br)
//       PhysicsFriends.wasm(.gz/.br)
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const STATIC_DIR = path.join(__dirname, 'public');
const ENABLE_CROSS_ORIGIN_ISOLATION =
  process.env.ENABLE_CROSS_ORIGIN_ISOLATION === '1' ||
  process.env.ENABLE_CROSS_ORIGIN_ISOLATION === 'true';
const HEARTBEAT_INTERVAL = 30000;
const MAX_PLAYERS_PER_ROOM = 4;
const ROOM_CODE_LENGTH = 4;

const rooms = new Map();
const wsToRoom = new Map();

// ---- MIME 类型（含 Unity WebGL 特殊格式）----
const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'application/javascript',
  '.css':'text/css', '.json':'application/json', '.png':'image/png',
  '.jpg':'image/jpeg', '.gif':'image/gif', '.svg':'image/svg+xml',
  '.ico':'image/x-icon', '.wasm':'application/wasm',
  '.data':'application/octet-stream', '.unityweb':'application/octet-stream',
};

// Unity 压缩文件的 Content-Encoding
function encodingHeaders(fp) {
  const h = {};
  if (fp.endsWith('.br')) {
    h['Content-Encoding'] = 'br';
    const inner = path.extname(fp.slice(0, -3));
    if (MIME[inner]) h['Content-Type'] = MIME[inner];
  } else if (fp.endsWith('.gz')) {
    h['Content-Encoding'] = 'gzip';
    const inner = path.extname(fp.slice(0, -3));
    if (MIME[inner]) h['Content-Type'] = MIME[inner];
  }
  return h;
}

// ================================================================
// HTTP 服务器 — 静态文件 + 状态页
// ================================================================
const httpServer = http.createServer((req, res) => {
  // 基础跨域头
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 只在线程版 WebGL 明确需要时开启 COEP/COOP。
  // 默认关闭，避免第三方图片 / 浏览器扩展资源被拦截。
  if (ENABLE_CROSS_ORIGIN_ISOLATION) {
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status:'ok', rooms:rooms.size, clients:wss.clients.size }));
  }

  if (req.url === '/api/status') {
    const list = [];
    for (const [code, r] of rooms)
      list.push({ code, players: r.players.filter(Boolean).map(p=>({i:p.playerIndex,n:p.name})), started:r.gameStarted });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ rooms:list, clients:wss.clients.size }));
  }

  // 静态文件
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const fp = path.join(STATIC_DIR, urlPath);

  if (!fp.startsWith(STATIC_DIR)) { res.writeHead(403); return res.end(); }

  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) {
      if (urlPath === '/index.html') return serveStatus(req, res);
      res.writeHead(404); return res.end('Not Found');
    }
    const ext = path.extname(fp).toLowerCase();
    const ct = MIME[ext] || 'application/octet-stream';
    const enc = encodingHeaders(fp);
    res.writeHead(200, { 'Content-Type':ct, 'Cache-Control':'public, max-age=3600', ...enc });
    fs.createReadStream(fp).pipe(res);
  });
});

function serveStatus(req, res) {
  const wsUrl = 'wss://physics-friend-server.onrender.com';
  const hasBuild = fs.existsSync(path.join(STATIC_DIR, 'Build'));
  let rows = '';
  for (const [code, r] of rooms) {
    const ns = r.players.filter(Boolean).map(p=>`${p.name}(#${p.playerIndex})`).join(', ');
    rows += `<tr><td><b style="color:#ffd866">${code}</b></td><td>${r.players.filter(Boolean).length}/${MAX_PLAYERS_PER_ROOM}</td><td>${r.gameStarted?'🎮游戏中':'⏳等待中'}</td><td>${ns}</td></tr>`;
  }
  res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>PhysicsFriends</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0e0f1a;color:#d0d0d0;padding:40px 20px}.w{max-width:700px;margin:0 auto}h1{color:#6ea8fe;font-size:28px}
.ok{color:#6bdf7b;font-weight:bold;font-size:18px;margin:12px 0 20px}.url{background:#161828;border:1px solid #2a2d45;border-radius:8px;padding:14px 18px;margin:16px 0}
.url code{color:#7ec8e3;font-size:15px}.url .l{color:#888;font-size:12px;display:block;margin-bottom:4px}
table{width:100%;border-collapse:collapse;margin:12px 0}th{text-align:left;color:#888;font-size:13px;padding:8px;border-bottom:1px solid #222}td{padding:8px;border-bottom:1px solid #1a1a2e;font-size:14px}
h3{color:#aab;margin-top:24px;font-size:16px}.warn{background:#2a1a10;border:1px solid #553a10;border-radius:8px;padding:14px;margin:16px 0;color:#f0a500;font-size:14px;line-height:1.7}
.dim{color:#666;font-size:13px;margin-top:30px}</style></head><body><div class="w">
  <h1>🎲 PhysicsFriends</h1><p class="ok">✅ 服务器运行中</p>
  <div class="url"><span class="l">WebSocket 地址</span><code>${wsUrl}</code></div>
  console.log(  隔离  → );
  ${!hasBuild?'<div class="warn">⚠️ <b>WebGL 尚未上传</b><br>将 Unity WebGL 构建产物放到 <code>public/Build/</code>，index.html 放到 <code>public/</code>，即可通过浏览器直接玩。</div>':''}
  <h3>📊 状态</h3><table><tr><td>房间</td><td><b>${rooms.size}</b></td></tr><tr><td>在线</td><td><b>${wss.clients.size}</b></td></tr><tr><td>运行</td><td>${(process.uptime()/60)|0}分钟</td></tr></table>
  <h3>🏠 房间</h3><table><tr><th>房间码</th><th>人数</th><th>状态</th><th>玩家</th></tr>${rows||'<tr><td colspan="4" style="color:#555">暂无</td></tr>'}</table>
  <p class="dim">PhysicsFriends Server v1.0</p></div></body></html>`);
}

// ================================================================
// WebSocket 服务器
// ================================================================
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', data => { try { handleMessage(ws, JSON.parse(data.toString())); } catch(e) { sendError(ws, e.message); } });
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});
const hb = setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) { ws.terminate(); return; } ws.isAlive = false; ws.ping(); }); }, HEARTBEAT_INTERVAL);
wss.on('close', () => clearInterval(hb));

httpServer.listen(PORT, '0.0.0.0', () => {
  const hasBuild = fs.existsSync(path.join(STATIC_DIR, 'Build'));
  console.log('=========================================');
  console.log(' PhysicsFriends Server');
  console.log(`  地址  → http://0.0.0.0:${PORT}`);
  console.log(`  WebGL → ${hasBuild ? '✅ 已就绪' : '⚠️ public/Build/ 未找到'}`);
  console.log('=========================================');
});

// ================================================================
// 协议处理
// ================================================================
function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create_room':  handleCreateRoom(ws, msg); break;
    case 'join_room':    handleJoinRoom(ws, msg); break;
    case 'start_game':   handleStartGame(ws); break;
    case 'to_host':      handleToHost(ws, msg); break;
    case 'to_player':    handleToPlayer(ws, msg); break;
    case 'to_all':       handleToAll(ws, msg); break;
    default: sendError(ws, `未知: ${msg.type}`);
  }
}

function handleCreateRoom(ws, msg) {
  handleDisconnect(ws, true);
  const code = genCode(), name = msg.name || '房主';
  const room = { code, players: [{ ws, name, playerIndex:0, alive:true }], gameStarted:false, hostIndex:0 };
  rooms.set(code, room); wsToRoom.set(ws, { roomCode:code, playerIndex:0 });
  send(ws, { type:'room_created', code, playerIndex:0 });
  console.log(`[Room] 创建 ${code} 房主:${name}`);
}

function handleJoinRoom(ws, msg) {
  const code = (msg.code||'').toUpperCase(), name = msg.name||'玩家', room = rooms.get(code);
  if (!room) return sendError(ws, `房间 ${code} 不存在`);
  if (room.gameStarted) return sendError(ws, '游戏已开始');
  if (room.players.length >= MAX_PLAYERS_PER_ROOM) return sendError(ws, '房间已满');
  handleDisconnect(ws, true);
  const pi = room.players.length;
  room.players.push({ ws, name, playerIndex:pi, alive:true });
  wsToRoom.set(ws, { roomCode:code, playerIndex:pi });
  send(ws, { type:'room_joined', code, playerIndex:pi });
  room.players.forEach(p => { if (p.ws !== ws && p.ws.readyState === WebSocket.OPEN) send(p.ws, { type:'player_joined', playerIndex:pi, name }); });
  room.players.forEach(p => { if (p.ws !== ws) send(ws, { type:'player_joined', playerIndex:p.playerIndex, name:p.name }); });
  console.log(`[Room] ${name}→${code} #${pi}`);
}

function handleStartGame(ws) {
  const i = wsToRoom.get(ws); if (!i) return sendError(ws, '未在房间');
  const r = rooms.get(i.roomCode); if (!r) return;
  if (i.playerIndex !== r.hostIndex) return sendError(ws, '只有房主可以开始');
  if (r.players.length < 2) return sendError(ws, '至少2人');
  r.gameStarted = true;
  r.players.forEach(p => { if (p && p.ws.readyState === WebSocket.OPEN) send(p.ws, { type:'game_started' }); });
  console.log(`[Room] ${i.roomCode} 开始 ${r.players.length}人`);
}

function handleToHost(ws, msg) {
  const i = wsToRoom.get(ws); if (!i) return;
  const r = rooms.get(i.roomCode); if (!r) return;
  const h = r.players[r.hostIndex];
  if (!h || h.ws.readyState !== WebSocket.OPEN) return sendError(ws, '房主断线');
  send(h.ws, { type:'from_client', playerIndex:i.playerIndex, payloadRaw: typeof msg.payload==='string'?msg.payload:JSON.stringify(msg.payload) });
}

function handleToPlayer(ws, msg) {
  const i = wsToRoom.get(ws); if (!i) return;
  const r = rooms.get(i.roomCode); if (!r) return;
  if (i.playerIndex !== r.hostIndex) return;
  const t = r.players[msg.targetPlayer];
  if (!t || t.ws.readyState !== WebSocket.OPEN) return;
  send(t.ws, { type:'from_host', payloadJson: typeof msg.payload==='string'?msg.payload:JSON.stringify(msg.payload) });
}

function handleToAll(ws, msg) {
  const i = wsToRoom.get(ws); if (!i) return;
  const r = rooms.get(i.roomCode); if (!r) return;
  if (i.playerIndex !== r.hostIndex) return;
  const p = typeof msg.payload==='string'?msg.payload:JSON.stringify(msg.payload);
  r.players.forEach(x => { if (x && x.playerIndex !== r.hostIndex && x.ws.readyState === WebSocket.OPEN) send(x.ws, { type:'from_host', payloadJson:p }); });
}

function handleDisconnect(ws, silent=false) {
  const i = wsToRoom.get(ws); if (!i) return;
  const r = rooms.get(i.roomCode); wsToRoom.delete(ws); if (!r) return;
  const idx = i.playerIndex;
  if (!silent) console.log(`[Room] #${idx} 离开 ${i.roomCode}`);
  if (idx === r.hostIndex) {
    r.players.forEach(p => { if (p && p.playerIndex!==idx && p.ws.readyState===WebSocket.OPEN) send(p.ws,{type:'host_disconnected'}); });
    r.players.forEach(p => { if (p) wsToRoom.delete(p.ws); });
    rooms.delete(i.roomCode);
    if (!silent) console.log(`[Room] ${i.roomCode} 销毁`);
  } else {
    r.players[idx] = null;
    r.players.forEach(p => { if (p && p.ws.readyState===WebSocket.OPEN) send(p.ws,{type:'player_disconnected',playerIndex:idx}); });
    if (r.players.every(p=>p===null)) rooms.delete(i.roomCode);
  }
}

function send(ws, o) { if (ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(o)); }
function sendError(ws, m) { send(ws, { type:'error', message:m }); }
function genCode() { const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s; do{s='';for(let i=0;i<ROOM_CODE_LENGTH;i++)s+=c[Math.random()*c.length|0];}while(rooms.has(s));return s; }

process.on('SIGINT', () => { wss.clients.forEach(ws=>ws.close()); httpServer.close(()=>process.exit(0)); });
setInterval(() => { if (rooms.size>0||wss.clients.size>0) console.log(`[S] 房间:${rooms.size} 在线:${wss.clients.size}`); }, 60000);


