const express = require('express');
const { WebSocketServer } = require('ws');
const { MongoClient } = require('mongodb');
const https = require('https');
const http  = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

app.get('/ping', (_req, res) => res.send('pong'));

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    setInterval(() => {
      const mod = RENDER_URL.startsWith('https') ? https : http;
      mod.get(`${RENDER_URL}/ping`, r => r.resume()).on('error', () => {});
    }, 10 * 60 * 1000);
  }
});

const wsss = new WebSocketServer({ server, maxPayload: 5 * 1024 * 1024 });

const MONGO_URI = process.env.MONGO_URI;
const ADMIN_UID = '4Nq6FGvrLDUzJWJypPOg6MywiMl1';
const MAX_MSGS  = 100;

let db, messagesCol, usersCol, bansCol, friendsCol, countersCol;
const clients = new Map(); // ws → { nick, uid, photoURL }

// ── NICK ──────────────────────────────────────────────────────────────
function getFirstName(displayName) {
  return (displayName || 'User').split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '') || 'User';
}

async function nextSequentialNick(firstName) {
  // atomically increment counter for this firstName prefix
  const result = await countersCol.findOneAndUpdate(
    { _id: firstName },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const seq = result.seq;
  return `${firstName}_${String(seq).padStart(4, '0')}`;
}

async function getOrCreateNick(uid, displayName) {
  const existing = await usersCol.findOne({ uid });
  if (existing?.nick) return existing.nick;
  const firstName = getFirstName(displayName);
  const nick = await nextSequentialNick(firstName);
  return nick;
}

// ── DB ────────────────────────────────────────────────────────────────
async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db          = client.db('mustachat');
  messagesCol = db.collection('messages');
  usersCol    = db.collection('users');
  bansCol     = db.collection('bans');
  friendsCol  = db.collection('friends');
  countersCol = db.collection('counters');
  console.log('MongoDB connected');
  // clean corrupt records
  await usersCol.deleteMany({ $or: [{ nick: null }, { nick: '' }, { nick: { $exists: false } }] });

  // ── ONE-TIME MIGRATION: rename full-name nicks → Firstname_0001 ──────
  const badNicks = await usersCol.find({ nick: { $regex: ' ' } }).toArray();
  for (const user of badNicks) {
    const oldNick = user.nick;
    const firstName = getFirstName(oldNick);
    const newNick = await nextSequentialNick(firstName);

    await usersCol.updateOne({ uid: user.uid }, { $set: { nick: newNick } });
    await messagesCol.updateMany({ from: oldNick }, { $set: { from: newNick } });
    await messagesCol.updateMany({ to:   oldNick }, { $set: { to:   newNick } });
    await friendsCol.updateMany({ userA: oldNick }, { $set: { userA: newNick } });
    await friendsCol.updateMany({ userB: oldNick }, { $set: { userB: newNick } });
    await friendsCol.updateMany({ requestedBy: oldNick }, { $set: { requestedBy: newNick } });
    console.log(`Migrated: "${oldNick}" → "${newNick}"`);
  }
  if (badNicks.length) console.log(`Migration done: ${badNicks.length} user(s) renamed.`);
}


// ── BANS ──────────────────────────────────────────────────────────────
async function isBanned(nick) {
  const ban = await bansCol.findOne({ nick });
  if (!ban) return false;
  if (ban.unbanAt > Date.now()) return true;
  await bansCol.deleteOne({ nick }); return false;
}

// ── FRIENDS ───────────────────────────────────────────────────────────
function friendKey(a, b) { return [a, b].sort().join('__'); }

async function getFriendList(nick) {
  const rows = await friendsCol.find({
    $or: [{ userA: nick }, { userB: nick }]
  }).toArray();
  return rows.map(r => ({
    nick:   r.userA === nick ? r.userB : r.userA,
    status: r.status,
    dir:    r.requestedBy === nick ? 'sent' : 'received'
  }));
}

// ── MESSAGES ──────────────────────────────────────────────────────────
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

// ── USERS ──────────────────────────────────────────────────────────────
async function saveUser(u) {
  await usersCol.updateOne({ uid: u.uid }, { $set: u }, { upsert: true });
}

// ── HELPERS ────────────────────────────────────────────────────────────
function sendTo(nick, payload) {
  for (const [ws, info] of clients) {
    if (info?.nick === nick && ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }
}

async function pushFriendsUpdate(nick) {
  const friends = await getFriendList(nick);
  // enrich with user data
  const enriched = await Promise.all(friends.map(async f => {
    const u = await usersCol.findOne({ nick: f.nick }, { projection:{ _id:0 } });
    const online = [...clients.values()].some(c => c?.nick === f.nick);
    return { ...f, photoURL: u?.photoURL||'', online, lastSeen: u?.lastSeen||0 };
  }));
  sendTo(nick, { type:'friends_update', friends: enriched });
}

// ── WS ────────────────────────────────────────────────────────────────
wsss.on('connection', ws => {
  clients.set(ws, null);

  ws.on('message', async raw => {
    let data; try { data = JSON.parse(raw.toString()); } catch { return; }

    // ── REGISTER ──────────────────────────────────────────────────────
    if (data.type === 'register') {
      const { uid, displayName, photoURL } = data;
      const nick = await getOrCreateNick(uid, displayName);
      if (await isBanned(nick)) { ws.send(JSON.stringify({ type:'error', message:'You are banned.' })); return; }
      for (const [old, info] of clients) {
        if (info?.uid === uid && old !== ws) { old.send(JSON.stringify({ type:'kicked_session' })); old.close(); clients.delete(old); break; }
      }
      clients.set(ws, { nick, uid, photoURL: photoURL||'' });
      await saveUser({ nick, uid, photoURL: photoURL||'', lastSeen: Date.now() });
      ws.send(JSON.stringify({ type:'registered', nick }));
      // send friends list
      await pushFriendsUpdate(nick);
      if (uid === ADMIN_UID) ws.send(JSON.stringify({ type:'admin_ready' }));
      // notify accepted friends that this user is now online
      const friends = await getFriendList(nick);
      for (const f of friends.filter(f => f.status === 'accepted')) pushFriendsUpdate(f.nick);
      return;
    }

    // ── USER SEARCH ───────────────────────────────────────────────────
    if (data.type === 'user_search') {
      const me = clients.get(ws); if (!me) return;
      const q = (data.query||'').trim().toLowerCase();
      if (q.length < 2) { ws.send(JSON.stringify({ type:'search_results', users:[] })); return; }
      const all = await usersCol.find({}, { projection:{_id:0} }).toArray();
      const myFriends = await getFriendList(me.nick);
      const friendNicks = new Set(myFriends.map(f => f.nick));
      const results = all
        .filter(u => u.nick && u.nick !== me.nick && u.nick.toLowerCase().includes(q))
        .map(u => {
          const f = myFriends.find(f => f.nick === u.nick);
          const online = [...clients.values()].some(c => c?.nick === u.nick);
          return { nick:u.nick, photoURL:u.photoURL||'', online, lastSeen:u.lastSeen||0,
                   friendStatus: f ? f.status : null, friendDir: f ? f.dir : null };
        });
      ws.send(JSON.stringify({ type:'search_results', users: results }));
      return;
    }

    // ── FRIEND REQUEST ────────────────────────────────────────────────
    if (data.type === 'friend_request') {
      const me = clients.get(ws); if (!me) return;
      const key = friendKey(me.nick, data.to);
      const existing = await friendsCol.findOne({ key });
      if (existing) return;
      await friendsCol.insertOne({ key, userA: me.nick, userB: data.to, status:'pending', requestedBy: me.nick, ts: Date.now() });
      await pushFriendsUpdate(me.nick);
      await pushFriendsUpdate(data.to);
      return;
    }

    // ── FRIEND ACCEPT ─────────────────────────────────────────────────
    if (data.type === 'friend_accept') {
      const me = clients.get(ws); if (!me) return;
      const key = friendKey(me.nick, data.from);
      await friendsCol.updateOne({ key }, { $set: { status:'accepted' } });
      await pushFriendsUpdate(me.nick);
      await pushFriendsUpdate(data.from);
      return;
    }

    // ── FRIEND REJECT / REMOVE ────────────────────────────────────────
    if (data.type === 'friend_reject' || data.type === 'friend_remove') {
      const me = clients.get(ws); if (!me) return;
      const key = friendKey(me.nick, data.with || data.from);
      await friendsCol.deleteOne({ key });
      await pushFriendsUpdate(me.nick);
      await pushFriendsUpdate(data.with || data.from);
      return;
    }

    // ── WebRTC RELAY ─────────────────────────────────────────────────
    const RELAY = ['call_offer','call_answer','call_reject','call_end','ice_candidate'];
    if (RELAY.includes(data.type)) {
      const me = clients.get(ws); if (!me) return;
      let ok = false;
      for (const [cws, info] of clients) {
        if (info?.nick === data.to && cws.readyState === cws.OPEN) { cws.send(JSON.stringify({ ...data, from: me.nick })); ok=true; break; }
      }
      if (!ok && data.type === 'call_offer') ws.send(JSON.stringify({ type:'call_reject', from:data.to, reason:'offline' }));
      return;
    }

    // ── DM OPEN ───────────────────────────────────────────────────────
    if (data.type === 'dm_open') {
      const me = clients.get(ws); if (!me) return;
      const history = await getMessages(getDmKey(me.nick, data.with));
      ws.send(JSON.stringify({ type:'dm_history', with:data.with, messages:history }));
      return;
    }

    // ── DM SEND ───────────────────────────────────────────────────────
    if (data.type === 'dm') {
      const me = clients.get(ws); if (!me) return;
      if (await isBanned(me.nick)) { ws.send(JSON.stringify({ type:'system_note', text:'You are banned.' })); return; }
      const ts = new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
      const msg = { from:me.nick, to:data.to, text:data.text||'', timestamp:ts,
        ...(data.audioData ? { audioData:data.audioData, audioDuration:data.audioDuration||0 } : {}) };
      await addMessage(getDmKey(me.nick, data.to), msg);
      for (const [cws, info] of clients) {
        if (info?.nick === data.to && cws.readyState === cws.OPEN) { cws.send(JSON.stringify({ type:'dm_receive', ...msg })); break; }
      }
      ws.send(JSON.stringify({ type:'dm_receive', ...msg }));
      return;
    }


    // ── PROFILE UPDATE (username + photo) ────────────────────────────
    if (data.type === 'profile_update') {
      const me = clients.get(ws); if (!me) return;
      const newNick  = (data.nick  || '').trim().replace(/[^a-zA-Z0-9_]/g, '');
      const newPhoto = (data.photoURL || '').trim();
      const oldNick  = me.nick;

      // ── Validate nick ──
      if (newNick && newNick !== oldNick) {
        if (newNick.length < 3 || newNick.length > 30) {
          ws.send(JSON.stringify({ type:'profile_error', msg:'Username must be 3–30 characters' })); return;
        }
        const taken = await usersCol.findOne({ nick: newNick });
        if (taken) { ws.send(JSON.stringify({ type:'profile_error', msg:'Username already taken' })); return; }

        // rename everywhere in DB
        await usersCol.updateOne({ uid: me.uid }, { $set: { nick: newNick } });
        await messagesCol.updateMany({ from: oldNick }, { $set: { from: newNick } });
        await messagesCol.updateMany({ to:   oldNick }, { $set: { to:   newNick } });
        await friendsCol.updateMany({ userA: oldNick }, { $set: { userA: newNick } });
        await friendsCol.updateMany({ userB: oldNick }, { $set: { userB: newNick } });
        await friendsCol.updateMany({ requestedBy: oldNick }, { $set: { requestedBy: newNick } });
        // rename key fields in message keys
        await messagesCol.updateMany(
          { key: { $regex: oldNick } },
          [{ $set: { key: { $replaceAll: { input: '$key', find: oldNick, replacement: newNick } } } }]
        );
        await bansCol.updateOne({ nick: oldNick }, { $set: { nick: newNick } });

        // update in-memory client record
        me.nick = newNick;
        clients.set(ws, me);
      }

      // ── Update photo ──
      if (newPhoto !== undefined) {
        await usersCol.updateOne({ uid: me.uid }, { $set: { photoURL: newPhoto } });
        me.photoURL = newPhoto;
        clients.set(ws, me);
      }

      // ── Confirm back to client ──
      ws.send(JSON.stringify({ type:'profile_updated', nick: me.nick, photoURL: me.photoURL }));

      // ── Notify friends so their sidebar updates ──
      const friendList = await getFriendList(me.nick);
      for (const f of friendList) pushFriendsUpdate(f.nick);
      await pushFriendsUpdate(me.nick);
      return;
    }
    // ── ADMIN: DELETE USER ────────────────────────────────────────────
    if (data.type === 'admin_delete_user') {
      const me = clients.get(ws); if (!me || me.uid !== ADMIN_UID) return;
      const target = data.target;
      // kick session
      for (const [cws, info] of clients) {
        if (info?.nick === target) { cws.send(JSON.stringify({ type:'kicked_session' })); cws.close(); break; }
      }
      // purge from DB
      await usersCol.deleteOne({ nick: target });
      await messagesCol.deleteMany({ $or:[{ from:target },{ to:target }] });
      await friendsCol.deleteMany({ $or:[{ userA:target },{ userB:target }] });
      await bansCol.deleteOne({ nick: target });
      ws.send(JSON.stringify({ type:'admin_ack', msg:`${target} deleted.` }));
      // update admin's friends list
      await pushFriendsUpdate(me.nick);
      return;
    }
  });

  ws.on('close', async () => {
    const info = clients.get(ws); clients.delete(ws);
    if (info) {
      await saveUser({ nick:info.nick, uid:info.uid, photoURL:info.photoURL, lastSeen:Date.now() });
      // notify friends of offline status
      const friends = await getFriendList(info.nick);
      for (const f of friends.filter(f => f.status === 'accepted')) pushFriendsUpdate(f.nick);
    }
  });
});

connectDB().catch(console.error);
