const express = require('express');
const { WebSocketServer } = require('ws');
const { MongoClient } = require('mongodb');
const https = require('https');
const http  = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

// ── KEEP-ALIVE: prevents Render free tier from sleeping ────────────────
app.get('/ping', (_req, res) => res.send('pong'));

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL; // auto-set by Render
  if (RENDER_URL) {
    setInterval(() => {
      // use built-in http/https — no fetch needed
      const mod = RENDER_URL.startsWith('https') ? https : http;
      mod.get(`${RENDER_URL}/ping`, res => res.resume()).on('error', () => {});
    }, 10 * 60 * 1000); // ping every 10 minutes
  }
});

// 5 MB max — needed for voice message audio base64
const wsss = new WebSocketServer({ server, maxPayload: 5 * 1024 * 1024 });

const MONGO_URI = process.env.MONGO_URI;
const ADMIN_UID = '4Nq6FGvrLDUzJWJypPOg6MywiMl1';
const MAX_MSGS  = 100;

let db, messagesCol, usersCol, bansCol;
const clients    = new Map();
const mutedUsers = new Set();
const badWords   = ["stupid","idiot","dumb","fuck","bitch","motherfucker","mf","dick","pussy","nigger"];

async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db          = client.db('mustachat');
  messagesCol = db.collection('messages');
  usersCol    = db.collection('users');
  bansCol     = db.collection('bans');
  console.log('MongoDB connected');
  // Clean up any corrupt user records with no nick
  const cleaned = await usersCol.deleteMany({ $or: [{ nick: null }, { nick: '' }, { nick: { $exists: false } }] });
  if (cleaned.deletedCount > 0) console.log(`Cleaned ${cleaned.deletedCount} corrupt user record(s)`);
}

function makeNick(displayName) {
  const first = (displayName || 'User').split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '');
  return `${first || 'User'}_${Math.floor(1000 + Math.random() * 9000)}`;
}
async function getOrCreateNick(uid, displayName) {
  const existing = await usersCol.findOne({ uid });
  if (existing?.nick) return existing.nick;
  let nick, attempts = 0;
  do {
    nick = makeNick(displayName);
    const taken = await usersCol.findOne({ nick });
    if (!taken) break;
  } while (++attempts < 20);
  return nick;
}

async function isBanned(nick) {
  const ban = await bansCol.findOne({ nick });
  if (!ban) return false;
  if (ban.unbanAt > Date.now()) return true;
  await bansCol.deleteOne({ nick });
  return false;
}
async function setBan(nick, minutes) {
  const unbanAt = Date.now() + minutes * 60000;
  await bansCol.updateOne({ nick }, { $set: { nick, unbanAt } }, { upsert: true });
}
async function removeBan(nick)       { await bansCol.deleteOne({ nick }); }
async function getBanRemaining(nick) {
  const ban = await bansCol.findOne({ nick });
  return ban ? Math.ceil((ban.unbanAt - Date.now()) / 60000) : 0;
}

function getDmKey(a, b) { return 'dm_' + [a, b].sort().join('__'); }

async function addMessage(key, msg) {
  await messagesCol.insertOne({ key, ...msg, ts: Date.now() });
  const count = await messagesCol.countDocuments({ key });
  if (count > MAX_MSGS) {
    const oldest = await messagesCol.find({ key }).sort({ ts:1 }).limit(count - MAX_MSGS).toArray();
    await messagesCol.deleteMany({ _id: { $in: oldest.map(d => d._id) } });
  }
}
async function getMessages(key) {
  return messagesCol.find({ key }, { projection:{ _id:0, key:0 } }).sort({ ts:1 }).limit(MAX_MSGS).toArray();
}

async function saveUser(u) {
  await usersCol.updateOne({ uid: u.uid }, { $set: u }, { upsert: true });
}
async function getAllUsers() {
  return usersCol.find({}, { projection:{ _id:0 } }).toArray();
}

async function broadcastAllUsers() {
  const online = new Set([...clients.values()].filter(Boolean).map(c => c.nick));
  const all    = (await getAllUsers()).map(u => ({ ...u, online: online.has(u.nick) }));
  const data   = JSON.stringify({ type:'all_users', users: all });
  wsss.clients.forEach(c => { if (c.readyState === c.OPEN) c.send(data); });
}
function sendTo(nick, payload) {
  for (const [ws, info] of clients) {
    if (info?.nick === nick && ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }
}

wsss.on('connection', ws => {
  clients.set(ws, null);

  ws.on('message', async raw => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    // ── REGISTER ──────────────────────────────────────────────────────
    if (data.type === 'register') {
      const { uid, displayName, photoURL } = data;
      const nick = await getOrCreateNick(uid, displayName);
      if (await isBanned(nick)) {
        const mins = await getBanRemaining(nick);
        ws.send(JSON.stringify({ type:'error', message:`Banned for ${mins} more minutes.` }));
        return;
      }
      for (const [old, info] of clients) {
        if (info?.uid === uid && old !== ws) {
          old.send(JSON.stringify({ type:'kicked_session' }));
          old.close(); clients.delete(old); break;
        }
      }
      clients.set(ws, { nick, uid, photoURL: photoURL||'' });
      await saveUser({ nick, uid, photoURL: photoURL||'', lastSeen: Date.now() });
      ws.send(JSON.stringify({ type:'registered', nick }));
      const online = new Set([...clients.values()].filter(Boolean).map(c => c.nick));
      const allNow = (await getAllUsers()).map(u => ({ ...u, online: online.has(u.nick) }));
      ws.send(JSON.stringify({ type:'all_users', users: allNow }));
      await broadcastAllUsers();
      if (uid === ADMIN_UID) ws.send(JSON.stringify({ type:'admin_ready' }));
      return;
    }

    // ── WebRTC SIGNALING RELAY ─────────────────────────────────────────
    // Server only forwards — never reads call content
    const RELAY_TYPES = ['call_offer','call_answer','call_reject','call_end','ice_candidate'];
    if (RELAY_TYPES.includes(data.type)) {
      const me = clients.get(ws);
      if (!me) return;
      let delivered = false;
      for (const [cws, info] of clients) {
        if (info?.nick === data.to && cws.readyState === cws.OPEN) {
          cws.send(JSON.stringify({ ...data, from: me.nick }));
          delivered = true; break;
        }
      }
      // Bounce back if callee is offline
      if (!delivered && data.type === 'call_offer') {
        ws.send(JSON.stringify({ type:'call_reject', from: data.to, reason:'offline' }));
      }
      return;
    }

    // ── DM OPEN ───────────────────────────────────────────────────────
    if (data.type === 'dm_open') {
      const me = clients.get(ws);
      if (!me) return;
      const history = await getMessages(getDmKey(me.nick, data.with));
      ws.send(JSON.stringify({ type:'dm_history', with: data.with, messages: history }));
      return;
    }

    // ── DM SEND (text or voice message) ───────────────────────────────
    if (data.type === 'dm') {
      const me = clients.get(ws);
      if (!me) return;
      if (await isBanned(me.nick)) {
        const mins = await getBanRemaining(me.nick);
        ws.send(JSON.stringify({ type:'system_note', text:`Banned for ${mins} more minutes.` })); return;
      }
      if (mutedUsers.has(me.nick.toLowerCase())) {
        ws.send(JSON.stringify({ type:'system_note', text:'You are muted.' })); return;
      }
      if (data.text && badWords.some(bw => data.text.toLowerCase().includes(bw))) {
        await setBan(me.nick, 35);
        ws.send(JSON.stringify({ type:'system_note', text:'Auto-banned 35 min: prohibited language.' })); return;
      }
      const timestamp = new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
      const msg = {
        from: me.nick, to: data.to,
        text: data.text || '', timestamp,
        ...(data.audioData ? { audioData: data.audioData, audioDuration: data.audioDuration||0 } : {})
      };
      await addMessage(getDmKey(me.nick, data.to), msg);
      for (const [cws, info] of clients) {
        if (info?.nick === data.to && cws.readyState === cws.OPEN) {
          cws.send(JSON.stringify({ type:'dm_receive', ...msg })); break;
        }
      }
      ws.send(JSON.stringify({ type:'dm_receive', ...msg }));
      return;
    }

    // ── ADMIN ─────────────────────────────────────────────────────────
    if (data.type === 'admin_cmd') {
      const me = clients.get(ws);
      if (!me || me.uid !== ADMIN_UID) return;
      const { cmd, target } = data;
      if (cmd==='ban')    { await setBan(target,35); sendTo(target,{type:'kicked_session'}); }
      if (cmd==='unban')  { await removeBan(target); sendTo(target,{type:'system_note',text:'Unbanned.'}); }
      if (cmd==='mute')   { mutedUsers.add(target.toLowerCase()); sendTo(target,{type:'system_note',text:'Muted.'}); }
      if (cmd==='unmute') { mutedUsers.delete(target.toLowerCase()); sendTo(target,{type:'system_note',text:'Unmuted.'}); }
      if (cmd==='kick')   { for(const[cws,info]of clients){if(info?.nick===target){cws.send(JSON.stringify({type:'kicked_session'}));cws.close();break;}} }
      ws.send(JSON.stringify({ type:'admin_ack', cmd, target }));
      return;
    }
  });

  ws.on('close', async () => {
    const info = clients.get(ws);
    clients.delete(ws);
    if (info) {
      await saveUser({ nick:info.nick, uid:info.uid, photoURL:info.photoURL, lastSeen:Date.now() });
      mutedUsers.delete(info.nick.toLowerCase());
    }
    await broadcastAllUsers();
  });
});

connectDB().catch(console.error);
