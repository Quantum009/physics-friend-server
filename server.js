// ============================================================
// server.js — PhysicsFriends WebSocket 中继服务器
//
// ★ Replit 兼容版 ★
// 核心改动: http.createServer 包裹 WebSocket
// Replit 要求 HTTP 端口可响应，纯 WS 端口会被判定为未启动
//
// 部署: Replit 上直接 Run，或 npm start
// ============================================================

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

// ---- 配置 ----
const PORT = parseInt(process.env.PORT, 10) || 8080;
const HEARTBEAT_INTERVAL = 30000;
const MAX_PLAYERS_PER_ROOM = 4;
const ROOM_CODE_LENGTH = 4;

// ---- 数据结构 ----
/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<WebSocket, {roomCode: string, playerIndex: number}>} */
const wsToRoom = new Map();

// ================================================================
// 1. HTTP 服务器 — 状态页 & 健康检查
//    Replit / UptimeRobot 会定期 GET /，必须返回 200
// ================================================================
const httpServer = http.createServer((req, res) => {
  // CORS 头（WebGL 构建可能跨域请求健康检查）
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      rooms: rooms.size,
      clients: wss.clients.size,
      uptime: process.uptime() | 0
    }));
    return;
  }

  // 状态首页
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

  let roomRows = '';
  for (const [code, room] of rooms) {
    const names = room.players
      .filter(Boolean)
      .map(p => `${p.name}(#${p.playerIndex})`)
      .join(', ');
    const status = room.gameStarted ? '🎮 游戏中' : '⏳ 等待中';
    roomRows += `<tr>
      <td><b style="color:#ffd866">${code}</b></td>
      <td>${room.players.filter(Boolean).length} / ${MAX_PLAYERS_PER_ROOM}</td>
      <td>${status}</td>
      <td>${names}</td>
    </tr>`;
  }

  const wsUrl = `wss://${req.headers.host}`;

  res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>PhysicsFriends Server</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0e0f1a;color:#d0d0d0;padding:40px 20px}
  .wrap{max-width:700px;margin:0 auto}
  h1{color:#6ea8fe;margin-bottom:8px;font-size:28px}
  .ok{color:#6bdf7b;font-weight:bold;font-size:18px;margin:12px 0 20px}
  .url-box{background:#161828;border:1px solid #2a2d45;border-radius:8px;padding:14px 18px;margin:16px 0;display:flex;align-items:center;gap:12px}
  .url-box code{color:#7ec8e3;font-size:15px;flex:1;word-break:break-all}
  .url-box .label{color:#888;font-size:12px;white-space:nowrap}
  .copy-btn{background:#2a5db0;color:#fff;border:none;padding:6px 14px;border-radius:5px;cursor:pointer;font-size:13px}
  .copy-btn:hover{background:#3a6dc0}
  table{width:100%;border-collapse:collapse;margin:12px 0}
  th{text-align:left;color:#888;font-size:13px;padding:8px;border-bottom:1px solid #222}
  td{padding:8px;border-bottom:1px solid #1a1a2e;font-size:14px}
  .dim{color:#666;font-size:13px;margin-top:30px}
  h3{color:#aab;margin-top:24px;font-size:16px}
  .step{background:#161828;border-radius:8px;padding:16px;margin:12px 0;line-height:1.7}
  .step b{color:#6ea8fe}
  .step code{background:#0e0f1a;padding:2px 6px;border-radius:3px;color:#ffd866}
</style></head><body>
<div class="wrap">
  <h1>🎲 PhysicsFriends 中继服务器</h1>
  <p class="ok">✅ 运行中</p>

  <div class="url-box">
    <span class="label">WebSocket 地址</span>
    <code id="ws-url">${wsUrl}</code>
    <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('ws-url').textContent)">复制</button>
  </div>

  <h3>📊 状态</h3>
  <table>
    <tr><td>房间数</td><td><b>${rooms.size}</b></td></tr>
    <tr><td>在线连接</td><td><b>${wss.clients.size}</b></td></tr>
    <tr><td>运行时间</td><td>${(process.uptime() / 60) | 0} 分钟</td></tr>
  </table>

  <h3>🏠 活跃房间</h3>
  <table>
    <tr><th>房间码</th><th>人数</th><th>状态</th><th>玩家</th></tr>
    ${roomRows || '<tr><td colspan="4" style="color:#555">暂无活跃房间</td></tr>'}
  </table>

  <h3>🔧 Unity 端配置</h3>
  <div class="step">
    在 Unity 的 <b>WebSocketClient</b> 组件上将 <code>serverUrl</code> 设为：<br>
    <code>${wsUrl}</code>
  </div>

  <p class="dim">PhysicsFriends Relay Server v1.0</p>
</div>
</body></html>`);
});

// ================================================================
// 2. WebSocket 服务器 — 挂载到 HTTP 服务器
// ================================================================
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    try {
      handleMessage(ws, JSON.parse(data.toString()));
    } catch (e) {
      sendError(ws, `消息解析失败: ${e.message}`);
    }
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

// 心跳
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);
wss.on('close', () => clearInterval(heartbeat));

// ---- 启动 ----
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log(' PhysicsFriends Relay Server');
  console.log(`  HTTP  → http://0.0.0.0:${PORT}`);
  console.log(`  WS    → ws://0.0.0.0:${PORT}`);
  console.log('========================================');
});

// ================================================================
// 消息处理（协议不变，和 Unity 端完全对应）
// ================================================================

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create_room':  handleCreateRoom(ws, msg);  break;
    case 'join_room':    handleJoinRoom(ws, msg);     break;
    case 'start_game':   handleStartGame(ws);         break;
    case 'to_host':      handleToHost(ws, msg);       break;
    case 'to_player':    handleToPlayer(ws, msg);     break;
    case 'to_all':       handleToAll(ws, msg);        break;
    default:             sendError(ws, `未知消息: ${msg.type}`);
  }
}

function handleCreateRoom(ws, msg) {
  handleDisconnect(ws, true);

  const code = generateRoomCode();
  const name = msg.name || '房主';
  const room = { code, players: [], gameStarted: false, hostIndex: 0 };
  room.players.push({ ws, name, playerIndex: 0, alive: true });

  rooms.set(code, room);
  wsToRoom.set(ws, { roomCode: code, playerIndex: 0 });
  send(ws, { type: 'room_created', code, playerIndex: 0 });
  console.log(`[Room] 创建 ${code}，房主: ${name}`);
}

function handleJoinRoom(ws, msg) {
  const code = (msg.code || '').toUpperCase();
  const name = msg.name || '玩家';

  const room = rooms.get(code);
  if (!room) return sendError(ws, `房间 ${code} 不存在`);
  if (room.gameStarted) return sendError(ws, '游戏已开始');
  if (room.players.length >= MAX_PLAYERS_PER_ROOM) return sendError(ws, '房间已满');

  handleDisconnect(ws, true);
  const playerIndex = room.players.length;
  room.players.push({ ws, name, playerIndex, alive: true });
  wsToRoom.set(ws, { roomCode: code, playerIndex });

  send(ws, { type: 'room_joined', code, playerIndex });

  // 通知其他人
  room.players.forEach(p => {
    if (p.ws !== ws && p.ws.readyState === WebSocket.OPEN)
      send(p.ws, { type: 'player_joined', playerIndex, name });
  });
  // 把已有玩家发给新人
  room.players.forEach(p => {
    if (p.ws !== ws)
      send(ws, { type: 'player_joined', playerIndex: p.playerIndex, name: p.name });
  });

  console.log(`[Room] ${name} → ${code} (#${playerIndex})`);
}

function handleStartGame(ws) {
  const info = wsToRoom.get(ws);
  if (!info) return sendError(ws, '未在房间中');
  const room = rooms.get(info.roomCode);
  if (!room) return;
  if (info.playerIndex !== room.hostIndex) return sendError(ws, '只有房主可以开始');
  if (room.players.length < 2) return sendError(ws, '至少需要2人');

  room.gameStarted = true;
  room.players.forEach(p => {
    if (p && p.ws.readyState === WebSocket.OPEN) send(p.ws, { type: 'game_started' });
  });
  console.log(`[Room] ${info.roomCode} 开始 (${room.players.length}人)`);
}

function handleToHost(ws, msg) {
  const info = wsToRoom.get(ws); if (!info) return;
  const room = rooms.get(info.roomCode); if (!room) return;
  const host = room.players[room.hostIndex];
  if (!host || host.ws.readyState !== WebSocket.OPEN) return sendError(ws, '房主已断线');
  send(host.ws, {
    type: 'from_client',
    playerIndex: info.playerIndex,
    payloadRaw: typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload)
  });
}

function handleToPlayer(ws, msg) {
  const info = wsToRoom.get(ws); if (!info) return;
  const room = rooms.get(info.roomCode); if (!room) return;
  if (info.playerIndex !== room.hostIndex) return;
  const target = room.players[msg.targetPlayer];
  if (!target || target.ws.readyState !== WebSocket.OPEN) return;
  send(target.ws, {
    type: 'from_host',
    payloadJson: typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload)
  });
}

function handleToAll(ws, msg) {
  const info = wsToRoom.get(ws); if (!info) return;
  const room = rooms.get(info.roomCode); if (!room) return;
  if (info.playerIndex !== room.hostIndex) return;
  const payload = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);
  room.players.forEach(p => {
    if (p && p.playerIndex !== room.hostIndex && p.ws.readyState === WebSocket.OPEN)
      send(p.ws, { type: 'from_host', payloadJson: payload });
  });
}

// ================================================================
// 断线处理
// ================================================================
function handleDisconnect(ws, silent = false) {
  const info = wsToRoom.get(ws);
  if (!info) return;
  const room = rooms.get(info.roomCode);
  wsToRoom.delete(ws);
  if (!room) return;

  const idx = info.playerIndex;
  if (!silent) console.log(`[Room] 玩家#${idx} 离开 ${info.roomCode}`);

  if (idx === room.hostIndex) {
    room.players.forEach(p => {
      if (p && p.playerIndex !== idx && p.ws.readyState === WebSocket.OPEN)
        send(p.ws, { type: 'host_disconnected' });
    });
    room.players.forEach(p => { if (p) wsToRoom.delete(p.ws); });
    rooms.delete(info.roomCode);
    if (!silent) console.log(`[Room] ${info.roomCode} 房主掉线，已销毁`);
  } else {
    room.players[idx] = null;
    room.players.forEach(p => {
      if (p && p.ws.readyState === WebSocket.OPEN)
        send(p.ws, { type: 'player_disconnected', playerIndex: idx });
    });
    if (room.players.every(p => p === null)) rooms.delete(info.roomCode);
  }
}

// ================================================================
// 工具
// ================================================================
function send(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function sendError(ws, message) { send(ws, { type: 'error', message }); }

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++)
      code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n[Server] 关闭中...');
  wss.clients.forEach(ws => ws.close());
  httpServer.close(() => process.exit(0));
});

// 状态日志
setInterval(() => {
  if (rooms.size > 0 || wss.clients.size > 0)
    console.log(`[Status] 房间:${rooms.size} 在线:${wss.clients.size}`);
}, 60000);
