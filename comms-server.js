"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Communications Module v1.0
// Real-time messaging + WebRTC signaling via Socket.IO
// Peer-to-peer calls, group chats, presence, notifications
// ═══════════════════════════════════════════════════════════════

module.exports = function attachComms(server) {
  const { Server } = require("socket.io");

  const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 30000,
    pingInterval: 10000,
  });

  // ── IN-MEMORY STATE ──────────────────────────────────────────
  // onlineUsers: { socketId → { username, title, avatar, status, socketId } }
  const onlineUsers = new Map();

  // rooms: { roomId → { id, name, type:'dm'|'group', members:Set<username>, messages:[] } }
  const rooms = new Map();

  // callSessions: { callId → { caller, callee, roomId, status, startedAt } }
  const callSessions = new Map();

  // messageStore: [ { id, roomId, from, text, type, ts } ] (last 500)
  const messageStore = [];
  const MAX_MESSAGES = 500;

  // ── HELPERS ──────────────────────────────────────────────────
  function getUserByName(username) {
    for (const [, user] of onlineUsers) {
      if (user.username === username) return user;
    }
    return null;
  }

  function getSocketByName(username) {
    const user = getUserByName(username);
    return user ? io.sockets.sockets.get(user.socketId) : null;
  }

  function getDMRoomId(a, b) {
    return [a, b].sort().join("::");
  }

  function getOrCreateRoom(type, members, name) {
    if (type === "dm") {
      const id = getDMRoomId(...members);
      if (!rooms.has(id)) {
        rooms.set(id, { id, name: members.join(" & "), type: "dm", members: new Set(members), messages: [] });
      }
      return rooms.get(id);
    }
    // group
    const id = "group::" + name.toLowerCase().replace(/\s+/g, "-") + "::" + Date.now();
    const room = { id, name, type: "group", members: new Set(members), messages: [], createdAt: Date.now() };
    rooms.set(id, room);
    return room;
  }

  function getRoomsForUser(username) {
    const result = [];
    for (const [, room] of rooms) {
      if (room.members.has(username)) {
        const msgs = messageStore.filter(m => m.roomId === room.id);
        result.push({ ...room, members: [...room.members], lastMessage: msgs[msgs.length - 1] || null });
      }
    }
    return result;
  }

  function storeMessage(msg) {
    messageStore.push(msg);
    if (messageStore.length > MAX_MESSAGES) messageStore.shift();
    const room = rooms.get(msg.roomId);
    if (room) room.messages = messageStore.filter(m => m.roomId === msg.roomId);
    return msg;
  }

  function broadcastUserList() {
    const users = [...onlineUsers.values()].map(u => ({
      username: u.username,
      title:    u.title,
      status:   u.status,
      avatar:   u.avatar,
    }));
    io.emit("users:list", users);
  }

  // ── CONNECTION ───────────────────────────────────────────────
  io.on("connection", (socket) => {
    console.log(`[COMMS] Socket connected: ${socket.id}`);

    // ── JOIN / REGISTER ───────────────────────────────────────
    socket.on("user:join", ({ username, title, avatar }) => {
      if (!username) return;

      // Disconnect any existing session for this user
      const existing = getUserByName(username);
      if (existing && existing.socketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(existing.socketId);
        if (oldSocket) oldSocket.disconnect(true);
      }

      const user = {
        username,
        title:    title    || "Sir",
        avatar:   avatar   || null,
        status:   "online",
        socketId: socket.id,
        joinedAt: Date.now(),
      };
      onlineUsers.set(socket.id, user);
      socket.data.username = username;

      // Re-join all their rooms
      for (const [, room] of rooms) {
        if (room.members.has(username)) socket.join(room.id);
      }

      // Send them their room list + recent messages
      socket.emit("user:joined", {
        you:   user,
        rooms: getRoomsForUser(username),
        recentMessages: messageStore.slice(-100),
      });

      broadcastUserList();
      console.log(`[COMMS] ${username} joined. Online: ${onlineUsers.size}`);
    });

    // ── STATUS UPDATE ─────────────────────────────────────────
    socket.on("user:status", ({ status }) => {
      const user = onlineUsers.get(socket.id);
      if (!user) return;
      user.status = status; // 'online' | 'away' | 'busy' | 'dnd'
      broadcastUserList();
    });

    // ── DIRECT MESSAGE ────────────────────────────────────────
    socket.on("message:send", ({ to, text, type = "text" }) => {
      const from = onlineUsers.get(socket.id);
      if (!from || !to || !text?.trim()) return;

      const room = getOrCreateRoom("dm", [from.username, to]);
      socket.join(room.id);

      // Make sure target also joins the room
      const targetSocket = getSocketByName(to);
      if (targetSocket) targetSocket.join(room.id);

      const msg = storeMessage({
        id:     `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        roomId: room.id,
        from:   from.username,
        to,
        text:   text.trim(),
        type,   // 'text' | 'system' | 'voice'
        ts:     Date.now(),
      });

      io.to(room.id).emit("message:received", { ...msg, room });

      // Notification to target if offline
      if (!targetSocket) {
        console.log(`[COMMS] ${to} is offline, message queued`);
      }
    });

    // ── GROUP MESSAGE ─────────────────────────────────────────
    socket.on("message:group", ({ roomId, text, type = "text" }) => {
      const from = onlineUsers.get(socket.id);
      const room = rooms.get(roomId);
      if (!from || !room || !text?.trim()) return;
      if (!room.members.has(from.username)) return;

      const msg = storeMessage({
        id:     `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        roomId,
        from:   from.username,
        text:   text.trim(),
        type,
        ts:     Date.now(),
      });

      io.to(roomId).emit("message:received", { ...msg, room });
    });

    // ── CREATE GROUP ──────────────────────────────────────────
    socket.on("group:create", ({ name, members }) => {
      const creator = onlineUsers.get(socket.id);
      if (!creator || !name || !members?.length) return;

      const allMembers = [...new Set([creator.username, ...members])];
      const room = getOrCreateRoom("group", allMembers, name);

      // Join all online members to the Socket.IO room
      for (const member of allMembers) {
        const s = getSocketByName(member);
        if (s) s.join(room.id);
      }

      const sysMsg = storeMessage({
        id:     `sys-${Date.now()}`,
        roomId: room.id,
        from:   "SYSTEM",
        text:   `${creator.username} created group "${name}" with ${allMembers.join(", ")}`,
        type:   "system",
        ts:     Date.now(),
      });

      io.to(room.id).emit("group:created", {
        room: { ...room, members: [...room.members] },
        message: sysMsg,
      });

      // Notify offline members next time they join
      for (const member of allMembers) {
        const s = getSocketByName(member);
        if (s) s.emit("room:update", { room: { ...room, members: [...room.members] } });
      }
    });

    // ── ADD MEMBER TO GROUP ───────────────────────────────────
    socket.on("group:addMember", ({ roomId, username }) => {
      const requester = onlineUsers.get(socket.id);
      const room = rooms.get(roomId);
      if (!requester || !room || room.type !== "group") return;
      if (!room.members.has(requester.username)) return;

      room.members.add(username);
      const s = getSocketByName(username);
      if (s) { s.join(roomId); s.emit("room:update", { room: { ...room, members: [...room.members] } }); }

      const sysMsg = storeMessage({
        id:     `sys-${Date.now()}`,
        roomId,
        from:   "SYSTEM",
        text:   `${requester.username} added ${username} to the group`,
        type:   "system",
        ts:     Date.now(),
      });
      io.to(roomId).emit("message:received", { ...sysMsg, room });
    });

    // ══════════════════════════════════════════════════════════
    // ── WebRTC CALL SIGNALING ─────────────────────────────────
    // ══════════════════════════════════════════════════════════

    // ── INITIATE CALL ─────────────────────────────────────────
    socket.on("call:initiate", ({ to, callType = "video" }) => {
      const caller = onlineUsers.get(socket.id);
      if (!caller || !to) return;

      const target = getUserByName(to);
      if (!target) {
        socket.emit("call:error", { reason: "User is offline" });
        return;
      }

      const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      callSessions.set(callId, {
        callId,
        caller:    caller.username,
        callee:    to,
        callType,
        status:    "ringing",
        startedAt: Date.now(),
      });

      // Ring the target
      const targetSocket = io.sockets.sockets.get(target.socketId);
      if (targetSocket) {
        targetSocket.emit("call:incoming", {
          callId,
          from:      caller.username,
          fromTitle: caller.title,
          callType,
        });
      }

      // Tell caller we're ringing
      socket.emit("call:ringing", { callId, to });
      console.log(`[COMMS] Call ${callId}: ${caller.username} → ${to} (${callType})`);
    });

    // ── ANSWER CALL ───────────────────────────────────────────
    socket.on("call:answer", ({ callId, accepted }) => {
      const session = callSessions.get(callId);
      if (!session) return;

      const callerSocket = getSocketByName(session.caller);
      if (!accepted) {
        session.status = "rejected";
        if (callerSocket) callerSocket.emit("call:rejected", { callId, by: session.callee });
        callSessions.delete(callId);
        return;
      }

      session.status = "connected";
      if (callerSocket) callerSocket.emit("call:accepted", { callId, by: session.callee });
      console.log(`[COMMS] Call ${callId} accepted`);
    });

    // ── WebRTC OFFER ──────────────────────────────────────────
    socket.on("call:offer", ({ callId, to, sdp }) => {
      const targetSocket = getSocketByName(to);
      if (targetSocket) targetSocket.emit("call:offer", { callId, from: socket.data.username, sdp });
    });

    // ── WebRTC ANSWER ─────────────────────────────────────────
    socket.on("call:sdp-answer", ({ callId, to, sdp }) => {
      const targetSocket = getSocketByName(to);
      if (targetSocket) targetSocket.emit("call:sdp-answer", { callId, from: socket.data.username, sdp });
    });

    // ── ICE CANDIDATE ─────────────────────────────────────────
    socket.on("call:ice-candidate", ({ callId, to, candidate }) => {
      const targetSocket = getSocketByName(to);
      if (targetSocket) targetSocket.emit("call:ice-candidate", { callId, from: socket.data.username, candidate });
    });

    // ── END CALL ──────────────────────────────────────────────
    socket.on("call:end", ({ callId, to }) => {
      const session = callSessions.get(callId);
      if (session) {
        session.status = "ended";
        const duration = Math.floor((Date.now() - session.startedAt) / 1000);
        session.duration = duration;
      }
      const targetSocket = getSocketByName(to);
      if (targetSocket) targetSocket.emit("call:ended", { callId, by: socket.data.username });
      callSessions.delete(callId);
    });

    // ── TYPING INDICATOR ─────────────────────────────────────
    socket.on("typing:start", ({ roomId }) => {
      const user = onlineUsers.get(socket.id);
      if (!user) return;
      socket.to(roomId).emit("typing:update", { roomId, username: user.username, typing: true });
    });
    socket.on("typing:stop", ({ roomId }) => {
      const user = onlineUsers.get(socket.id);
      if (!user) return;
      socket.to(roomId).emit("typing:update", { roomId, username: user.username, typing: false });
    });

    // ── MESSAGE HISTORY ───────────────────────────────────────
    socket.on("messages:history", ({ roomId, limit = 50 }) => {
      const msgs = messageStore.filter(m => m.roomId === roomId).slice(-limit);
      socket.emit("messages:history", { roomId, messages: msgs });
    });

    // ── DISCONNECT ────────────────────────────────────────────
    socket.on("disconnect", () => {
      const user = onlineUsers.get(socket.id);
      if (user) {
        console.log(`[COMMS] ${user.username} disconnected`);
        onlineUsers.delete(socket.id);
        broadcastUserList();
      }
    });
  });

  console.log("[COMMS] Socket.IO communications layer attached");
  return io;
};
