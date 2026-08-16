import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import db from './database.js';

dotenv.config();

process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 5000
});

const PORT = process.env.PORT || 3000;

// Initialize Database
await db.initDatabase();

app.set('trust proxy', true);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Active tracking
const waitingQueue = {
  voice: [],
  video: [],
  text: []
};

// Map socket.id -> session data
const activeUsers = new Map();
// Map socket.id -> current room
const userRooms = new Map();
// Map room.id -> { id, user1, user2, mode, startTime, game: null }
const activeRooms = new Map();
// Map sessionToken -> socket.id (for direct friend calling)
const tokenToSocket = new Map();

// Helper: Profanity filtering
const badWordsList = ['spam', 'scam', 'abuse', 'phishing', 'malware'];
function sanitizeText(text) {
  if (!text || typeof text !== 'string') return '';
  let sanitized = text.slice(0, 1000);
  badWordsList.forEach(word => {
    const reg = new RegExp(`\\b${word}\\b`, 'gi');
    sanitized = sanitized.replace(reg, '*'.repeat(word.length));
  });
  return sanitized;
}

// REST Endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/stats', async (req, res) => {
  const dbStats = await db.getStats();
  const onlineCount = activeUsers.size;
  const inCallCount = activeRooms.size * 2;
  const inQueueCount = waitingQueue.voice.length + waitingQueue.video.length + waitingQueue.text.length;

  res.json({
    online: Math.max(onlineCount, 1),
    inCalls: inCallCount,
    inQueue: inQueueCount,
    totalMatches: (dbStats.total_matches || 0) + 1284,
    totalMessages: (dbStats.total_messages || 0) + 8420
  });
});

app.get('/api/topics', (req, res) => {
  const trendingTopics = [
    { id: 'casual', name: 'Casual Talk', icon: '💬', count: 1420 },
    { id: 'gaming', name: 'Gaming', icon: '🎮', count: 980 },
    { id: 'music', name: 'Music & Songs', icon: '🎵', count: 750 },
    { id: 'language', name: 'Language Exchange', icon: '🌍', count: 640 },
    { id: 'movies', name: 'Movies & Anime', icon: '🎬', count: 520 },
    { id: 'tech', name: 'Tech & Coding', icon: '💻', count: 430 },
    { id: 'dating', name: 'Dating & Vibes', icon: '✨', count: 1100 },
    { id: 'deep', name: 'Deep Thoughts', icon: '🌙', count: 390 }
  ];
  res.json(trendingTopics);
});

app.get('/api/friends/:token', async (req, res) => {
  const token = req.params.token;
  if (!token) return res.status(400).json({ error: 'Token required' });
  const friends = await db.getFriends(token);
  // Add online status
  const friendsWithStatus = friends.map(f => ({
    ...f,
    online: tokenToSocket.has(f.friend_token)
  }));
  res.json(friendsWithStatus);
});

app.post('/api/friends/save', async (req, res) => {
  const { userToken, friendToken, friendName, friendAvatar } = req.body;
  if (!userToken || !friendToken) {
    return res.status(400).json({ error: 'Tokens required' });
  }
  const saved = await db.saveFriend(userToken, friendToken, friendName || 'Friend', friendAvatar || 'avatar-1');
  res.json({ success: saved });
});

app.post('/api/report', async (req, res) => {
  const { reporterToken, reportedToken, reason, details, ip } = req.body;
  const logged = await db.logReport(reporterToken, reportedToken, reason, details);
  if (ip && reason === 'severe_inappropriate') {
    await db.banIp(ip, reason);
  }
  res.json({ success: logged });
});

// Dynamic STUN & TURN Ice Servers configuration
app.get('/api/ice-servers', (req, res) => {
  const iceServers = [
    // Standard Global STUN Servers
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.services.mozilla.com' },
    { urls: 'stun:stun.sipgate.net:10000' },

    // Free OpenRelay / Metered TURN Relay Servers (Handles Symmetric NAT & Strict Wi-Fi)
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];

  // Custom environment TURN configuration support
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.unshift({
      urls: process.env.TURN_URL.split(',').map(u => u.trim()),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }

  res.json({ iceServers });
});

// Matchmaking Logic
function findMatch(socket, mode, preferences) {
  const queue = waitingQueue[mode] || [];
  if (queue.length === 0) return null;

  const now = Date.now();
  const socketData = activeUsers.get(socket.id);
  const previousPartners = socketData?.previousPartners || new Set();

  let bestIndex = -1;
  let bestScore = -1;

  for (let i = 0; i < queue.length; i++) {
    const candidate = queue[i];
    if (candidate.socket.id === socket.id) continue;
    if (previousPartners.has(candidate.socket.id)) continue;

    let score = 10; // Base score
    const candidatePrefs = candidate.preferences;

    // Topic intersection
    if (preferences.topics && candidatePrefs.topics) {
      const common = preferences.topics.filter(t => candidatePrefs.topics.includes(t));
      score += common.length * 15;
    }

    // Country match
    if (preferences.country && preferences.country !== 'GLOBAL' && candidatePrefs.country === preferences.country) {
      score += 20;
    }

    // Time in queue bonus (fairness)
    const waitTimeSec = (now - candidate.joinedAt) / 1000;
    score += Math.min(waitTimeSec * 5, 50);

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  // Fallback 1: If no strict match but queue has someone not in previous partners, pick oldest
  if (bestIndex === -1 && queue.length > 0) {
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].socket.id !== socket.id && !previousPartners.has(queue[i].socket.id)) {
        bestIndex = i;
        break;
      }
    }
  }

  // Fallback 2 (Small Pool Support): If everyone in queue is a previous partner, allow rematching rather than stalling
  if (bestIndex === -1 && queue.length > 0) {
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].socket.id !== socket.id) {
        bestIndex = i;
        break;
      }
    }
  }

  if (bestIndex !== -1) {
    const [matchedCandidate] = queue.splice(bestIndex, 1);
    return matchedCandidate;
  }

  return null;
}

function removeFromAllQueues(socketId) {
  for (const mode of ['voice', 'video', 'text']) {
    const idx = waitingQueue[mode].findIndex(item => item.socket.id === socketId);
    if (idx !== -1) {
      waitingQueue[mode].splice(idx, 1);
    }
  }
}

function leaveCurrentRoom(socket, reason = 'partner_left') {
  const roomId = userRooms.get(socket.id);
  if (!roomId) return;

  const room = activeRooms.get(roomId);
  if (room) {
    const partnerId = room.user1 === socket.id ? room.user2 : room.user1;
    const duration = Math.round((Date.now() - room.startTime) / 1000);

    const user1Data = activeUsers.get(room.user1);
    const user2Data = activeUsers.get(room.user2);

    db.logMatch(user1Data?.sessionToken, user2Data?.sessionToken, room.mode, duration);

    if (partnerId) {
      userRooms.delete(partnerId);
      io.to(partnerId).emit('partner-disconnected', { reason, duration });
    }

    activeRooms.delete(roomId);
  }

  userRooms.delete(socket.id);
  socket.leave(roomId);
}

// High-Speed Matchmaking Sweeper (Runs every 100ms for instant pairing)
function processMatchmakingSweep() {
  for (const mode of ['voice', 'video', 'text']) {
    const queue = waitingQueue[mode];
    if (!queue || queue.length < 2) continue;

    for (let i = 0; i < queue.length; i++) {
      const candidate = queue[i];
      if (!candidate || !candidate.socket || !candidate.socket.connected) {
        queue.splice(i, 1);
        i--;
        continue;
      }

      const match = findMatch(candidate.socket, mode, candidate.preferences);
      if (match) {
        // Remove candidate as well
        const cIdx = queue.findIndex(item => item.socket.id === candidate.socket.id);
        if (cIdx !== -1) queue.splice(cIdx, 1);

        const socket = candidate.socket;
        const partnerSocket = match.socket;
        const roomId = `room_${uuidv4()}`;

        const userData = activeUsers.get(socket.id) || {};
        const partnerData = activeUsers.get(partnerSocket.id) || {};

        if (userData.previousPartners) {
          userData.previousPartners.add(partnerSocket.id);
          if (userData.previousPartners.size > 8) {
            const first = userData.previousPartners.values().next().value;
            userData.previousPartners.delete(first);
          }
        }
        if (partnerData.previousPartners) {
          partnerData.previousPartners.add(socket.id);
          if (partnerData.previousPartners.size > 8) {
            const first = partnerData.previousPartners.values().next().value;
            partnerData.previousPartners.delete(first);
          }
        }

        socket.join(roomId);
        partnerSocket.join(roomId);
        userRooms.set(socket.id, roomId);
        userRooms.set(partnerSocket.id, roomId);

        activeRooms.set(roomId, {
          id: roomId,
          user1: socket.id,
          user2: partnerSocket.id,
          mode,
          startTime: Date.now(),
          game: null
        });

        socket.emit('match-found', {
          roomId,
          mode,
          isInitiator: true,
          partner: {
            nickname: partnerData.nickname || 'Stranger',
            avatar: partnerData.avatar || 'avatar-1',
            country: partnerData.country || 'GLOBAL',
            topics: partnerData.topics || [],
            sessionToken: partnerData.sessionToken
          }
        });

        partnerSocket.emit('match-found', {
          roomId,
          mode,
          isInitiator: false,
          partner: {
            nickname: userData.nickname || 'Stranger',
            avatar: userData.avatar || 'avatar-1',
            country: userData.country || 'GLOBAL',
            topics: userData.topics || [],
            sessionToken: userData.sessionToken
          }
        });

        db.incrementStat('total_matches');
        break;
      }
    }
  }
}

setInterval(processMatchmakingSweep, 100);

// Socket.IO Events
io.on('connection', async (socket) => {
  const clientIp = socket.handshake.headers['cf-connecting-ip'] || 
                   socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                   socket.handshake.address;

  // Check if IP is banned
  const isBanned = await db.isIpBanned(clientIp);
  if (isBanned) {
    socket.emit('banned', { reason: 'Your IP is suspended due to violations.' });
    socket.disconnect(true);
    return;
  }

  // Available 3D Avatars List
  const ALL_AVATARS = [
    'avatar-fox', 'avatar-panda', 'avatar-cat', 'avatar-robot',
    'avatar-astro', 'avatar-lion', 'avatar-shiba', 'avatar-koala',
    'avatar-owl', 'avatar-dragon', 'avatar-tiger'
  ];

  // Register user session
  socket.on('init-session', async (data) => {
    const sessionToken = data.sessionToken || uuidv4();
    const nickname = data.nickname || `Guest_${Math.floor(1000 + Math.random() * 9000)}`;
    const randomAvatar = ALL_AVATARS[Math.floor(Math.random() * ALL_AVATARS.length)];
    const avatar = (data.avatar && ALL_AVATARS.includes(data.avatar)) ? data.avatar : (data.avatar || randomAvatar);
    const country = data.country || 'GLOBAL';
    const gender = data.gender || 'any';

    const user = await db.getOrCreateUser(sessionToken, nickname, avatar, country, gender);

    activeUsers.set(socket.id, {
      sessionToken,
      nickname,
      avatar,
      country,
      gender,
      topics: data.topics || [],
      previousPartners: new Set()
    });

    tokenToSocket.set(sessionToken, socket.id);

    socket.emit('session-ready', {
      sessionToken,
      user,
      socketId: socket.id
    });

    io.emit('online-count-update', { online: activeUsers.size });
  });

  // Join Matchmaking Queue
  socket.on('join-queue', (data) => {
    removeFromAllQueues(socket.id);
    leaveCurrentRoom(socket, 'skipped');

    const mode = data.mode || 'voice';
    const preferences = {
      country: data.country || 'GLOBAL',
      gender: data.gender || 'any',
      topics: data.topics || []
    };

    const userData = activeUsers.get(socket.id) || {};
    userData.topics = preferences.topics;
    userData.country = preferences.country;
    userData.gender = preferences.gender;

    socket.emit('queue-joined', { mode, preferences });

    const match = findMatch(socket, mode, preferences);

    if (match) {
      const partnerSocket = match.socket;
      const roomId = `room_${uuidv4()}`;

      // Mark previous partner to avoid instant re-match
      userData.previousPartners = userData.previousPartners || new Set();
      userData.previousPartners.add(partnerSocket.id);
      if (userData.previousPartners.size > 8) {
        const first = userData.previousPartners.values().next().value;
        userData.previousPartners.delete(first);
      }

      const partnerData = activeUsers.get(partnerSocket.id) || {};
      partnerData.previousPartners = partnerData.previousPartners || new Set();
      partnerData.previousPartners.add(socket.id);
      if (partnerData.previousPartners.size > 8) {
        const first = partnerData.previousPartners.values().next().value;
        partnerData.previousPartners.delete(first);
      }

      // Join room
      socket.join(roomId);
      partnerSocket.join(roomId);

      userRooms.set(socket.id, roomId);
      userRooms.set(partnerSocket.id, roomId);

      activeRooms.set(roomId, {
        id: roomId,
        user1: socket.id,
        user2: partnerSocket.id,
        mode,
        startTime: Date.now(),
        game: null
      });

      // Socket is caller (initiator), partner is callee
      socket.emit('match-found', {
        roomId,
        mode,
        isInitiator: true,
        partner: {
          nickname: partnerData.nickname || 'Stranger',
          avatar: partnerData.avatar || 'avatar-1',
          country: partnerData.country || 'GLOBAL',
          topics: partnerData.topics || [],
          sessionToken: partnerData.sessionToken
        }
      });

      partnerSocket.emit('match-found', {
        roomId,
        mode,
        isInitiator: false,
        partner: {
          nickname: userData.nickname || 'Stranger',
          avatar: userData.avatar || 'avatar-1',
          country: userData.country || 'GLOBAL',
          topics: userData.topics || [],
          sessionToken: userData.sessionToken
        }
      });

      db.incrementStat('total_matches');
    } else {
      // Put in queue
      waitingQueue[mode].push({
        socket,
        preferences,
        joinedAt: Date.now()
      });
    }
  });

  // Leave Queue
  socket.on('leave-queue', () => {
    removeFromAllQueues(socket.id);
    socket.emit('queue-left');
  });

  // WebRTC Signaling
  socket.on('signal-offer', (data) => {
    const roomId = data?.roomId || userRooms.get(socket.id);
    if (!roomId) return;
    socket.to(roomId).emit('signal-offer', { offer: data.offer });
  });

  socket.on('signal-answer', (data) => {
    const roomId = data?.roomId || userRooms.get(socket.id);
    if (!roomId) return;
    socket.to(roomId).emit('signal-answer', { answer: data.answer });
  });

  socket.on('signal-ice-candidate', (data) => {
    const roomId = data?.roomId || userRooms.get(socket.id);
    if (!roomId) return;
    socket.to(roomId).emit('signal-ice-candidate', { candidate: data.candidate });
  });

  // Text Chat & Messages
  socket.on('send-message', (data) => {
    const roomId = data?.roomId || userRooms.get(socket.id);
    if (!roomId) return;

    const sanitized = sanitizeText(data.text);
    const msgPayload = {
      id: uuidv4(),
      senderId: socket.id,
      text: sanitized,
      timestamp: Date.now()
    };

    io.to(roomId).emit('new-message', msgPayload);
    db.incrementStat('total_messages');
  });

  socket.on('typing', (data) => {
    const roomId = data?.roomId || userRooms.get(socket.id);
    if (!roomId) return;
    socket.to(roomId).emit('partner-typing', { isTyping: Boolean(data.isTyping) });
  });

  socket.on('send-reaction', (data) => {
    const roomId = data?.roomId || userRooms.get(socket.id);
    if (!roomId) return;
    io.to(roomId).emit('reaction-received', {
      emoji: data.emoji,
      senderId: socket.id
    });
  });

  // Next stranger / Skip
  socket.on('next-partner', (data) => {
    const currentMode = data?.mode || 'voice';
    const prefs = data?.preferences || {};
    leaveCurrentRoom(socket, 'skipped');
    // Re-trigger join-queue
    socket.emit('request-rejoin-queue', { mode: currentMode, preferences: prefs });
  });

  // Hang Up
  socket.on('hang-up', () => {
    removeFromAllQueues(socket.id);
    leaveCurrentRoom(socket, 'hung_up');
    socket.emit('call-ended');
  });

  // Interactive Mini-Games & Icebreakers
  socket.on('game-start-request', (data) => {
    const roomId = userRooms.get(socket.id);
    if (!roomId) return;
    socket.to(roomId).emit('game-invitation', {
      gameType: data.gameType,
      senderName: activeUsers.get(socket.id)?.nickname || 'Partner'
    });
  });

  socket.on('game-response', (data) => {
    const roomId = userRooms.get(socket.id);
    if (!roomId) return;
    const room = activeRooms.get(roomId);
    if (room && data.accepted) {
      room.game = {
        type: data.gameType,
        state: data.initialState || {},
        turn: socket.id
      };
    }
    io.to(roomId).emit('game-started', {
      accepted: data.accepted,
      gameType: data.gameType,
      initialState: data.initialState,
      turnId: socket.id
    });
  });

  socket.on('game-move', (data) => {
    const roomId = userRooms.get(socket.id);
    if (!roomId) return;
    socket.to(roomId).emit('game-move-received', data);
  });

  socket.on('icebreaker-draw', (data) => {
    const roomId = userRooms.get(socket.id);
    if (!roomId) return;
    io.to(roomId).emit('icebreaker-shared', {
      question: data.question,
      senderName: activeUsers.get(socket.id)?.nickname || 'Stranger'
    });
  });

  // Friend System: Direct Reconnect & Request
  socket.on('send-friend-request', () => {
    const roomId = userRooms.get(socket.id);
    if (!roomId) return;
    const userData = activeUsers.get(socket.id);
    socket.to(roomId).emit('friend-request-received', {
      friendToken: userData?.sessionToken,
      friendName: userData?.nickname,
      friendAvatar: userData?.avatar
    });
  });

  socket.on('accept-friend-request', async (data) => {
    const userData = activeUsers.get(socket.id);
    if (!userData) return;
    await db.saveFriend(userData.sessionToken, data.friendToken, data.friendName, data.friendAvatar);
    socket.emit('friend-added-success', { friendName: data.friendName });
  });

  // Direct Call a Friend
  socket.on('direct-call-friend', (data) => {
    const targetSocketId = tokenToSocket.get(data.friendToken);
    if (!targetSocketId) {
      socket.emit('friend-offline', { friendToken: data.friendToken });
      return;
    }
    const callerData = activeUsers.get(socket.id);
    io.to(targetSocketId).emit('incoming-direct-call', {
      callerToken: callerData?.sessionToken,
      callerName: callerData?.nickname || 'Friend',
      callerAvatar: callerData?.avatar || 'avatar-1',
      callerSocketId: socket.id,
      mode: data.mode || 'voice'
    });
  });

  socket.on('accept-direct-call', (data) => {
    const callerSocket = io.sockets.sockets.get(data.callerSocketId);
    if (!callerSocket) {
      socket.emit('call-failed', { message: 'Caller is no longer available.' });
      return;
    }

    removeFromAllQueues(socket.id);
    removeFromAllQueues(callerSocket.id);
    leaveCurrentRoom(socket, 'direct_call');
    leaveCurrentRoom(callerSocket, 'direct_call');

    const roomId = `direct_${uuidv4()}`;
    socket.join(roomId);
    callerSocket.join(roomId);

    userRooms.set(socket.id, roomId);
    userRooms.set(callerSocket.id, roomId);

    const callerData = activeUsers.get(callerSocket.id) || {};
    const calleeData = activeUsers.get(socket.id) || {};

    activeRooms.set(roomId, {
      id: roomId,
      user1: callerSocket.id,
      user2: socket.id,
      mode: data.mode || 'voice',
      startTime: Date.now(),
      game: null
    });

    callerSocket.emit('match-found', {
      roomId,
      mode: data.mode || 'voice',
      isInitiator: true,
      isDirectCall: true,
      partner: {
        nickname: calleeData.nickname || 'Friend',
        avatar: calleeData.avatar || 'avatar-1',
        country: calleeData.country || 'GLOBAL',
        sessionToken: calleeData.sessionToken
      }
    });

    socket.emit('match-found', {
      roomId,
      mode: data.mode || 'voice',
      isInitiator: false,
      isDirectCall: true,
      partner: {
        nickname: callerData.nickname || 'Friend',
        avatar: callerData.avatar || 'avatar-1',
        country: callerData.country || 'GLOBAL',
        sessionToken: callerData.sessionToken
      }
    });
  });

  // Disconnect Handling
  socket.on('disconnect', () => {
    removeFromAllQueues(socket.id);
    leaveCurrentRoom(socket, 'disconnected');

    const userData = activeUsers.get(socket.id);
    if (userData && userData.sessionToken) {
      tokenToSocket.delete(userData.sessionToken);
    }
    activeUsers.delete(socket.id);

    io.emit('online-count-update', { online: activeUsers.size });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`  🚀 MTalk Server running on http://0.0.0.0:${PORT}`);
  console.log(`  🌐 Local / Cloudflare Tunnel Target: http://localhost:${PORT}`);
  console.log(`  ⚡ WebRTC Signaling Ready & Database Initialized`);
  console.log(`=======================================================`);
});
