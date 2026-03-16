const express = require('express');
const { WebSocketServer } = require('ws');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
const wsss   = new WebSocketServer({ server });

const MONGO_URI  = process.env.MONGO_URI;
const ADMIN_UID  = '4Nq6FGvrLDUzJWJypPOg6MywiMl1';
const MAX_MSGS  = 100;

let db, messagesCol, usersCol, bansCol;

const clients    = new Map(); // ws -> { nick, uid, photoURL }
const mutedUsers = new Set();
let isChatFrozen = false;

const badWords = ["stupid","idiot","dumb","fuck","bitch","motherfucker","mf","dick","pussy","nigger"];

// ── MONGO CONNECT ─────────────────────────────────────────────────────
async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db          = client.db('mustachat');
  messagesCol = db.collection('messages');
  usersCol    = db.collection('users');
  bansCol     = db.collection('bans');
  console.log('MongoDB connected');
}

// ── BANS ──────────────────────────────────────────────────────────────
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
async function removeBan(nick) { await bansCol.deleteOne({ nick }); }
async function getBanRemaining(nick) {
  const ban = await bansCol.findOne({ nick });
  return ban ? Math.ceil((ban.unbanAt - Date.now()) / 60000) : 0;
}

// ── MESSAGES ──────────────────────────────────────────────────────────
function getDmKey(a, b) { return 'dm_' + [a, b].sort().join('__'); }

async function addMessage(key, msg) {
  await messagesCol.insertOne({ key, ...msg, ts: Date.now() });
  // keep only last MAX_MSGS per key
  const count = await messagesCol.countDocuments({ key });
  if (count > MAX_MSGS) {
    const oldest = await messagesCol.find({ key }).sort({ ts: 1 }).limit(count - MAX_MSGS).toArray();
    const ids = oldest.map(d => d._id);
    await messagesCol.deleteMany({ _id: { $in: ids } });
  }
}
async function getMessages(key) {
  return messagesCol.find({ key }, { projection: { _id:0, key:0 } }).sort({ ts: 1 }).limit(MAX_MSGS).toArray();
}

// ── USERS ─────────────────────────────────────────────────────────────
async function saveUser(user) {
  await usersCol.updateOne({ nick: user.nick }, { $set: user }, { upsert: true });
}
async function getAllUsers() {
  return usersCol.find({}, { projection: { _id:0 } }).toArray();
}

// ── BROADCAST ─────────────────────────────────────────────────────────
async function broadcastAllUsers() {
  const online = new Set([...clients.values()].filter(Boolean).map(c => c.nick));
  const all    = (await getAllUsers()).map(u => ({ ...u, online: online.has(u.nick) }));
  const data   = JSON.stringify({ type: 'all_users', users: all });
  wsss.clients.forEach(c => { if (c.readyState === c.OPEN) c.send(data); });
}

async function broadcastChat(nick, text) {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const msg = { nick, text, timestamp };
  if (nick !== 'SYSTEM') await addMessage('global', msg);
  const data = JSON.stringify({ type: 'chat', ...msg });
  wsss.clients.forEach(c => { if (c.readyState === c.OPEN) c.send(data); });
}

async function sendAction(target, type, minutes) {
  if (type === 'ban') await setBan(target, minutes);
  for (let [ws, info] of clients) {
    if (info?.nick === target && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type, minutes }));
      return true;
    }
  }
  return false;
}

// ── WEBSOCKET ─────────────────────────────────────────────────────────
wsss.on('connection', ws => {
  clients.set(ws, null);

  ws.on('message', async raw => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch(e) { return; }

    // ── REGISTER ──
    if (data.type === 'register') {
      const { nick, uid, photoURL } = data;

      if (await isBanned(nick)) {
        const mins = await getBanRemaining(nick);
        ws.send(JSON.stringify({ type:'error', message:`You are banned for ${mins} more minutes.` }));
        return;
      }

      // kick old session with same UID
      for (let [oldWs, info] of clients) {
        if (info?.uid === uid && oldWs !== ws) {
          oldWs.send(JSON.stringify({ type:'kicked_session' }));
          oldWs.close();
          clients.delete(oldWs);
          break;
        }
      }

      const taken = [...clients.values()].find(c => c?.nick === nick);
      if (taken && taken.uid !== uid) {
        ws.send(JSON.stringify({ type:'error', message:`Nickname '${nick}' is already taken!` }));
        return;
      }

      clients.set(ws, { nick, uid, photoURL: photoURL||'' });
      await saveUser({ nick, uid, photoURL: photoURL||'', lastSeen: Date.now() });

      const history = await getMessages('global');
      ws.send(JSON.stringify({ type:'history', messages: history }));
      await broadcastAllUsers();
      await broadcastChat('SYSTEM', `${nick.toLowerCase()==='nimda'?'ADMIN':nick} has joined the chat.`);
      if (uid === ADMIN_UID) ws.send(JSON.stringify({ type:'admin_ready' }));
      return;
    }

    // ── DM OPEN ──
    if (data.type === 'dm_open') {
      const me = clients.get(ws);
      if (!me) return;
      const history = await getMessages(getDmKey(me.nick, data.with));
      ws.send(JSON.stringify({ type:'dm_history', with: data.with, messages: history }));
      return;
    }

    // ── DM SEND ──
    if (data.type === 'dm') {
      const me = clients.get(ws);
      if (!me) return;
      const timestamp = new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
      const msg = { from: me.nick, to: data.to, text: data.text, timestamp };
      await addMessage(getDmKey(me.nick, data.to), msg);
      for (let [cws, info] of clients) {
        if (info?.nick === data.to && cws.readyState === cws.OPEN) { cws.send(JSON.stringify({ type:'dm_receive', ...msg })); break; }
      }
      ws.send(JSON.stringify({ type:'dm_receive', ...msg }));
      return;
    }

    // ── CHAT ──
    if (data.type === 'chat') {
      const { nick, text } = data;
      const lnick = nick.toLowerCase();
      const uid   = clients.get(ws)?.uid;

      if (await isBanned(nick)) {
        const mins = await getBanRemaining(nick);
        ws.send(JSON.stringify({ type:'chat', nick:'SYSTEM', text:`You are banned for ${mins} more minutes.` }));
        return;
      }
      if (mutedUsers.has(lnick)) { ws.send(JSON.stringify({ type:'chat', nick:'SYSTEM', text:'You are muted.' })); return; }
      if (isChatFrozen && lnick !== 'nimda') { ws.send(JSON.stringify({ type:'chat', nick:'SYSTEM', text:'Chat is frozen by Admin.' })); return; }
      if (badWords.some(bw => text.toLowerCase().includes(bw))) {
        await sendAction(nick, 'ban', 35);
        await broadcastChat('SYSTEM', `${nick} was auto-banned for prohibited language.`);
        return;
      }

      // admin commands
      if (uid === ADMIN_UID && text.startsWith('/')) {
        const parts = text.trim().split(/\s+/);
        const [cmd, target, ...rest] = parts;
        if (cmd==='/freeze'||cmd==='/unfreeze') { isChatFrozen=cmd==='/freeze'; await broadcastChat('SYSTEM',`Admin ${isChatFrozen?'FROZEN':'UNFROZEN'} the chat.`); }
        else if (cmd==='/ban'&&target)    { (await sendAction(target,'ban',35)) ? await broadcastChat('SYSTEM',`Admin banned ${target}.`) : await broadcastChat('SYSTEM',`${target} not found.`); }
        else if (cmd==='/kick'&&target)   { (await sendAction(target,'kick',5))  ? await broadcastChat('SYSTEM',`Admin kicked ${target}.`) : await broadcastChat('SYSTEM',`${target} not found.`); }
        else if (cmd==='/mute'&&target)   { mutedUsers.add(target.toLowerCase()); await broadcastChat('SYSTEM',`Admin muted ${target}.`); }
        else if (cmd==='/unmute'&&target) { mutedUsers.delete(target.toLowerCase()); await broadcastChat('SYSTEM',`Admin unmuted ${target}.`); }
        else if (cmd==='/unban'&&target)  { await removeBan(target); await broadcastChat('SYSTEM',`Admin unbanned ${target}.`); }
        else if (cmd==='/clear')          { wsss.clients.forEach(c=>{if(c.readyState===c.OPEN)c.send(JSON.stringify({type:'clear'}))}); await broadcastChat('SYSTEM','Admin cleared the chat.'); }
        else if (cmd==='/highlight'&&parts.length>1) { const txt=parts.slice(1).join(' '); wsss.clients.forEach(c=>{if(c.readyState===c.OPEN)c.send(JSON.stringify({type:'highlight',text:txt}))}); }
        else if (cmd==='/rename'&&target&&rest[0]) {
          for(let[cws,info]of clients){if(info?.nick===target){info.nick=rest[0];clients.set(cws,info);break;}}
          await broadcastAllUsers(); await broadcastChat('SYSTEM',`${target} renamed to ${rest[0]} by Admin.`);
        }
        return;
      }

      await broadcastChat(nick, text);
    }
  });

  ws.on('close', async () => {
    const info = clients.get(ws);
    clients.delete(ws);
    if (info) {
      await saveUser({ nick: info.nick, uid: info.uid, photoURL: info.photoURL, lastSeen: Date.now() });
      await broadcastChat('SYSTEM', `${info.nick.toLowerCase()==='nimda'?'ADMIN':info.nick} has left the chat.`);
      mutedUsers.delete(info.nick.toLowerCase());
    }
    await broadcastAllUsers();
  });
});

connectDB().catch(console.error);