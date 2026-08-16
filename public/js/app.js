/**
 * MTalk Main Application Controller
 * Handles Socket.IO lifecycle, WebRTC orchestrator, UI screen transitions,
 * in-call chat, friends, games, VIP paid features, auto-next, and media permissions.
 */

const AVATAR_MAP = {
  'avatar-fox': 'assets/avatar-fox.jpg',
  'avatar-panda': 'assets/avatar-panda.jpg',
  'avatar-cat': 'assets/avatar-cat.jpg',
  'avatar-robot': 'assets/avatar-robot.jpg',
  'avatar-astro': 'assets/avatar-astro.jpg',
  'avatar-lion': 'assets/avatar-lion.jpg',
  '🦊': 'assets/avatar-fox.jpg',
  '🐼': 'assets/avatar-panda.jpg',
  '🦁': 'assets/avatar-lion.jpg',
  '🦄': 'assets/avatar-astro.jpg',
  '🚀': 'assets/avatar-astro.jpg',
  '⚡': 'assets/avatar-robot.jpg',
  '🐱': 'assets/avatar-cat.jpg',
  'avatar-1': 'assets/avatar-fox.jpg',
  'avatar-2': 'assets/avatar-panda.jpg',
  'avatar-3': 'assets/avatar-cat.jpg',
  'avatar-4': 'assets/avatar-robot.jpg',
  'avatar-5': 'assets/avatar-astro.jpg',
  'avatar-6': 'assets/avatar-lion.jpg'
};

function getAvatarSrc(avatarKey) {
  return AVATAR_MAP[avatarKey] || 'assets/avatar-fox.jpg';
}

class MTalkApp {
  constructor() {
    this.socket = null;
    this.webrtc = null;
    this.gameManager = null;

    // User profile state
    this.sessionToken = localStorage.getItem('mtalk_session_token') || null;
    this.nickname = localStorage.getItem('mtalk_nickname') || `Guest_${Math.floor(1000 + Math.random() * 9000)}`;
    this.avatar = localStorage.getItem('mtalk_avatar') || 'avatar-fox';
    this.country = localStorage.getItem('mtalk_country') || 'GLOBAL';
    this.gender = localStorage.getItem('mtalk_gender') || 'any';
    this.isVip = localStorage.getItem('mtalk_is_vip') === 'true';
    this.autoNext = localStorage.getItem('mtalk_auto_next') !== 'false'; // default true
    this.selectedTopics = JSON.parse(localStorage.getItem('mtalk_topics') || '["casual"]');
    this.selectedMode = 'voice'; // 'voice', 'video', 'text'

    // Call runtime state
    this.currentRoomId = null;
    this.partner = null;
    this.isInCall = false;
    this.isSearching = false;
    this.callStartTime = null;
    this.callTimerInterval = null;
    this.wakeLock = null;

    // Visualizers
    this.localVisualizer = null;
    this.remoteVisualizer = null;

    // Typing timeout
    this.typingTimeout = null;

    this.init();
  }

  async init() {
    this.initSocket();
    this.initUIEventListeners();
    this.initTopics();
    this.updateUserProfileUI();
    this.loadStats();
    this.initAudioVisualizers();
    this.setupMobileGestures();
    this.refreshIcons();


    // Ask camera & microphone permissions immediately upon opening site
    this.promptPermissionsOnLoad();
  }

  refreshIcons() {
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  // 1. Initial Permission Request on Site Open
  async promptPermissionsOnLoad() {
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(async () => {
          return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        });
        if (stream) {
          console.log('[Permissions] Camera & Microphone granted on site open.');
          this.webrtc.localStream = stream;
        }
      }
    } catch (e) {
      console.warn('[Permissions] Initial prompt dismissed or denied:', e);
    }
  }

  // 2. Socket.IO Lifecycle
  initSocket() {
    this.socket = io({
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 15,
      reconnectionDelay: 1000
    });

    this.webrtc = new WebRTCManager(this.socket);
    this.gameManager = new GameManager(this.socket, this.webrtc);

    this.setupSocketEvents();
    this.setupWebRTCEvents();
    this.setupGameEvents();
  }

  setupSocketEvents() {
    this.socket.on('connect', () => {
      console.log('[Socket] Connected. ID:', this.socket.id);
      this.socket.emit('init-session', {
        sessionToken: this.sessionToken,
        nickname: this.nickname,
        avatar: this.avatar,
        country: this.country,
        gender: this.gender,
        topics: this.selectedTopics
      });
    });

    this.socket.on('session-ready', (data) => {
      this.sessionToken = data.sessionToken;
      localStorage.setItem('mtalk_session_token', this.sessionToken);
      this.updateUserProfileUI();
    });

    this.socket.on('online-count-update', (data) => {
      const el = document.getElementById('stat-online-count');
      if (el) el.textContent = `${data.online.toLocaleString()} Online`;
    });

    this.socket.on('queue-joined', () => {
      this.isSearching = true;
      if (!this.isInCall) {
        this.showScreen('radar');
      } else {
        this.showInCallSearchOverlay(true, 'Finding someone new...');
      }
    });

    this.socket.on('queue-left', () => {
      this.isSearching = false;
      this.showInCallSearchOverlay(false);
      this.showScreen('lobby');
    });

    this.socket.on('match-found', async (data) => {
      console.log('[Match] Partner Found:', data);
      window.SoundEffects.playMatchFound();
      this.currentRoomId = data.roomId;
      this.webrtc.setRoomId(data.roomId);
      this.partner = data.partner;
      this.selectedMode = data.mode;
      this.isInCall = true;
      this.isSearching = false;

      this.showInCallSearchOverlay(false);
      if (this.selectedMode === 'text') {
        this.showScreen('text');
      } else {
        this.showScreen('call');
      }
      this.setupInCallPartnerUI();
      this.requestWakeLock();

      // Start WebRTC connection or text chat
      await this.startMediaAndCall(data.isInitiator);
    });

    this.socket.on('request-rejoin-queue', (data) => {
      this.joinQueue(data.mode, data.preferences);
    });

    this.socket.on('partner-disconnected', (data) => {
      window.SoundEffects.playDisconnect();
      this.showToast(`Partner disconnected (${data.reason || 'left'}).`);
      this.addSystemMessage('Partner has disconnected.');
      this.endCallCleanup(false);

      // Auto-Next handling
      if (this.autoNext) {
        this.showInCallSearchOverlay(true, 'Partner left. Finding someone new...');
        setTimeout(() => {
          this.joinQueue(this.selectedMode);
        }, 500);
      } else {
        setTimeout(() => this.showScreen('lobby'), 1500);
      }
    });

    this.socket.on('call-ended', () => {
      this.endCallCleanup(true);
      this.showScreen('lobby');
    });

    this.socket.on('new-message', (msg) => {
      this.renderMessage(msg);
      if (msg.senderId !== this.socket.id) {
        window.SoundEffects.playMessagePop();
        const chatSidebar = document.getElementById('chatSidebar');
        if (chatSidebar && !chatSidebar.classList.contains('chat-panel-mobile-visible')) {
          document.getElementById('chat-unread-dot')?.classList.add('active');
          document.getElementById('chat-mobile-dot')?.classList.add('active');
        }
      }
    });

    this.socket.on('partner-typing', (data) => {
      const indicator = document.getElementById('typingIndicator');
      const textIndicator = document.getElementById('textTypingIndicator');
      const textStatus = document.getElementById('textPartnerStatus');
      if (data.isTyping) {
        if (indicator) indicator.classList.remove('hidden');
        if (textIndicator) textIndicator.classList.remove('hidden');
        if (textStatus) textStatus.textContent = 'typing...';
      } else {
        if (indicator) indicator.classList.add('hidden');
        if (textIndicator) textIndicator.classList.add('hidden');
        if (textStatus) textStatus.textContent = 'online';
      }
    });

    this.socket.on('reaction-received', (data) => {
      this.showFloatingReaction(data.emoji);
    });

    this.socket.on('icebreaker-shared', (data) => {
      this.showIcebreakerModal(data.question, data.senderName);
      this.addSystemMessage(`💡 Icebreaker: "${data.question}"`);
    });

    this.socket.on('friend-request-received', (data) => {
      this.showFriendRequestModal(data);
    });

    this.socket.on('friend-added-success', (data) => {
      this.showToast(`🎉 ${data.friendName} added to your Friends!`);
    });

    this.socket.on('incoming-direct-call', (data) => {
      this.showIncomingCallModal(data);
    });

    this.socket.on('banned', (data) => {
      alert(`Account Notice: ${data.reason}`);
      this.showScreen('lobby');
    });
  }

  setupWebRTCEvents() {
    this.socket.on('signal-offer', async (data) => {
      await this.webrtc.handleOffer(data.offer);
    });

    this.socket.on('signal-answer', async (data) => {
      await this.webrtc.handleAnswer(data.answer);
    });

    this.socket.on('signal-ice-candidate', async (data) => {
      await this.webrtc.handleIceCandidate(data.candidate);
    });

    this.webrtc.onRemoteStream = (remoteStream) => {
      console.log('[WebRTC] Remote stream tracks:', remoteStream.getTracks());
      const remoteVideo = document.getElementById('strangerVideo') || document.getElementById('remote-video');
      const remoteAudio = document.getElementById('remote-audio-sink');
      const strangerAvatar = document.getElementById('strangerAvatar');
      const strangerVisualizer = document.getElementById('strangerVisualizer');

      // 1. Audio stream playback via dedicated remote audio sink
      if (remoteAudio) {
        if (remoteAudio.srcObject !== remoteStream) {
          remoteAudio.srcObject = remoteStream;
        }
        remoteAudio.muted = this.webrtc.isSpeakerMuted;
        const playPromise = remoteAudio.play();
        if (playPromise !== undefined) {
          playPromise.catch(err => {
            console.warn('[Audio] Remote audio autoplay blocked:', err);
            this.unlockAudioAutoplay();
          });
        }
      }

      // 2. Video stream display via strangerVideo
      const videoTracks = remoteStream.getVideoTracks();
      const hasVideo = videoTracks.length > 0 && videoTracks.some(t => t.readyState === 'live');

      if (remoteVideo) {
        if (remoteVideo.srcObject !== remoteStream) {
          remoteVideo.srcObject = remoteStream;
        }
        // Keep video element muted so playback is NEVER blocked by browser audio autoplay policy
        remoteVideo.muted = true;
        const vPromise = remoteVideo.play();
        if (vPromise !== undefined) {
          vPromise.catch(e => console.warn('[Video] Remote video play warning:', e));
        }

        if (hasVideo && this.selectedMode === 'video') {
          remoteVideo.style.opacity = '1';
          if (strangerAvatar) strangerAvatar.style.opacity = '0';
        } else {
          remoteVideo.style.opacity = '0';
          if (strangerAvatar) strangerAvatar.style.opacity = '1';
        }
      }

      if (strangerVisualizer) {
        strangerVisualizer.classList.add('visualizer-active');
      }

      if (this.remoteVisualizer) {
        this.remoteVisualizer.connectStream(remoteStream);
      }

      videoTracks.forEach(track => {
        track.onended = () => {
          if (remoteVideo) remoteVideo.style.opacity = '0';
          if (strangerAvatar) strangerAvatar.style.opacity = '1';
        };
        track.onmute = () => {
          if (remoteVideo) remoteVideo.style.opacity = '0';
          if (strangerAvatar) strangerAvatar.style.opacity = '1';
        };
        track.onunmute = () => {
          if (this.selectedMode === 'video') {
            if (remoteVideo) remoteVideo.style.opacity = '1';
            if (strangerAvatar) strangerAvatar.style.opacity = '0';
          }
        };
      });
    };
  }

  unlockAudioAutoplay() {
    const unlock = () => {
      const remoteAudio = document.getElementById('remote-audio-sink');
      if (remoteAudio && remoteAudio.srcObject) {
        remoteAudio.play().catch(() => {});
      }
      if (window.SoundEffects && window.SoundEffects.ctx && window.SoundEffects.ctx.state === 'suspended') {
        window.SoundEffects.ctx.resume();
      }
      document.removeEventListener('click', unlock);
      document.removeEventListener('touchstart', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('click', unlock, { once: true });
    document.addEventListener('touchstart', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
  }

  setupGameEvents() {
    this.socket.on('game-invitation', (data) => {
      const accepted = confirm(`${data.senderName} invited you to play ${data.gameType === 'tictactoe' ? 'Tic-Tac-Toe' : 'Rock-Paper-Scissors'}! Accept?`);
      this.socket.emit('game-response', {
        gameType: data.gameType,
        accepted,
        initialState: {}
      });
      if (accepted) {
        this.openGameModal(data.gameType, false);
      }
    });

    this.socket.on('game-started', (data) => {
      if (data.accepted) {
        this.openGameModal(data.gameType, data.turnId === this.socket.id);
      } else {
        this.showToast('Partner declined the game invite.');
      }
    });

    this.socket.on('game-move-received', (data) => {
      this.gameManager.handleRemoteMove(data);
    });

    this.gameManager.onStateUpdate = (state) => {
      this.renderGameState(state);
    };
  }

  // 3. Media Stream & Permission Verification
  async checkPermissionsAndStart(mode = 'voice') {
    if (mode === 'text') return true;

    const granted = await this.webrtc.checkAndRequestPermissions(mode);
    if (!granted) {
      document.getElementById('modal-permission')?.classList.add('active');
      this.refreshIcons();
      return false;
    }
    return true;
  }

  async startMediaAndCall(isInitiator) {
    if (this.selectedMode === 'text') {
      this.startCallTimer();
      this.refreshIcons();
      return;
    }

    this.webrtc.setRoomId(this.currentRoomId);
    this.webrtc.mode = this.selectedMode;
    const localStream = await this.webrtc.getLocalMedia(this.selectedMode);
    const localVideo = document.getElementById('localVideo') || document.getElementById('local-video');
    const localAvatar = document.getElementById('localAvatar');
    const strangerAvatar = document.getElementById('strangerAvatar');
    const strangerVideo = document.getElementById('strangerVideo') || document.getElementById('remote-video');

    if (this.selectedMode === 'video' && localStream && localStream.getVideoTracks().length > 0) {
      if (localVideo) {
        localVideo.srcObject = localStream;
        localVideo.muted = true;
        localVideo.style.opacity = '1';
        localVideo.play().catch(() => {});
      }
      if (localAvatar) localAvatar.style.opacity = '0';
    } else {
      if (localVideo) localVideo.style.opacity = '0';
      if (localAvatar) localAvatar.style.opacity = '1';
      if (strangerAvatar) strangerAvatar.style.opacity = '1';
      if (strangerVideo) strangerVideo.style.opacity = '0';
    }

    if (localStream && this.localVisualizer) {
      this.localVisualizer.connectStream(localStream);
    }

    // Create WebRTC PeerConnection
    this.webrtc.createPeerConnection(isInitiator);

    if (isInitiator) {
      await this.webrtc.createOffer();
    }

    this.startCallTimer();
    this.refreshIcons();
  }

  initAudioVisualizers() {
    const localCanvas  = document.getElementById('local-audio-canvas');
    const remoteCanvas = document.getElementById('remote-audio-canvas');

    if (localCanvas && !this.localVisualizer) {
      this.localVisualizer = new AudioWaveVisualizer(localCanvas);
    }

    if (remoteCanvas && !this.remoteVisualizer) {
      this.remoteVisualizer = new AudioWaveVisualizer(remoteCanvas);
      this.remoteVisualizer.onSpeakingStateChange = (speaking) => {
        const ring = document.getElementById('remote-avatar-ring');
        if (ring) {
          if (speaking) ring.classList.add('speaking');
          else          ring.classList.remove('speaking');
        }
      };
    }
  }

  showInCallSearchOverlay(show, message = 'Finding someone new...') {
    const overlay = document.getElementById('incall-search-overlay');
    const title = document.getElementById('incall-overlay-title');
    if (overlay) {
      overlay.style.display = show ? 'flex' : 'none';
      if (title) title.textContent = message;
    }
  }

  // 4. Matchmaking & Queue Handlers
  async joinQueue(mode = 'voice', customPrefs = null) {
    window.SoundEffects.playButtonClick();
    this.selectedMode = mode;

    // Check media permissions
    const hasPermission = await this.checkPermissionsAndStart(mode);
    if (!hasPermission) return;

    const prefs = customPrefs || {
      country: this.country,
      gender: this.gender,
      topics: this.selectedTopics
    };

    const radarModeEl = document.getElementById('radar-mode-text');
    const radarFilterEl = document.getElementById('radar-filter-tags');
    if (radarModeEl) radarModeEl.textContent = `Searching for ${mode.toUpperCase()} partner...`;
    if (radarFilterEl) radarFilterEl.textContent = `${this.country === 'GLOBAL' ? 'Global' : this.country} • ${this.selectedTopics.join(', ') || 'All Topics'}`;

    this.socket.emit('join-queue', {
      mode,
      ...prefs
    });
  }

  cancelQueue() {
    window.SoundEffects.playButtonClick();
    this.socket.emit('leave-queue');
  }

  nextStranger() {
    window.SoundEffects.playSkip();
    this.showInCallSearchOverlay(true, 'Finding someone new...');
    this.endCallCleanup(false);
    this.socket.emit('next-partner', {
      mode: this.selectedMode,
      preferences: {
        country: this.country,
        gender: this.gender,
        topics: this.selectedTopics
      }
    });
  }

  hangUpCall() {
    window.SoundEffects.playButtonClick();
    this.endCallCleanup(true);
    this.socket.emit('hang-up');
    this.showScreen('lobby');
  }

  endCallCleanup(fullReset = true) {
    this.currentRoomId = null;
    this.partner = null;

    if (this.callTimerInterval) {
      clearInterval(this.callTimerInterval);
      this.callTimerInterval = null;
    }

    // Hide timers
    document.getElementById('callTimer')?.classList.add('hidden');
    document.getElementById('textCallTimer')?.classList.add('hidden');

    // Reset status badges
    const statusEl = document.getElementById('connectionStatus');
    if (statusEl) statusEl.innerHTML = '<span class="text-gray-400">Waiting</span>';
    const textStatusEl = document.getElementById('textConnectionStatus');
    if (textStatusEl) textStatusEl.innerHTML = '<span class="text-gray-400">Waiting</span>';

    const noticeEl = document.getElementById('chatStatusNotice');
    if (noticeEl) noticeEl.textContent = 'Waiting for next partner...';
    const textNoticeEl = document.getElementById('textChatStatusNotice');
    if (textNoticeEl) textNoticeEl.textContent = 'Press Start to find a partner';

    if (this.localVisualizer) this.localVisualizer.stop();
    if (this.remoteVisualizer) this.remoteVisualizer.stop();

    const localVideo = document.getElementById('localVideo') || document.getElementById('local-video');
    if (localVideo) { localVideo.srcObject = null; localVideo.style.opacity = '0'; }
    const localAvatar = document.getElementById('localAvatar');
    if (localAvatar) localAvatar.style.opacity = '1';

    const remoteVideo = document.getElementById('strangerVideo') || document.getElementById('remote-video');
    if (remoteVideo) { remoteVideo.srcObject = null; remoteVideo.style.opacity = '0'; }
    const strangerAvatar = document.getElementById('strangerAvatar');
    if (strangerAvatar) strangerAvatar.style.opacity = '1';

    const strangerVisualizer = document.getElementById('strangerVisualizer');
    if (strangerVisualizer) strangerVisualizer.classList.remove('visualizer-active');

    const remoteAudio = document.getElementById('remote-audio-sink');
    if (remoteAudio) remoteAudio.srcObject = null;

    this.webrtc.closePeerConnection();
    this.gameManager.reset();

    if (fullReset) {
      this.isInCall = false;
      this.webrtc.reset();
      this.releaseWakeLock();

      const connStatus = document.getElementById('connectionStatus');
      if (connStatus) {
        connStatus.className = 'badge badge-secondary py-1 px-3';
        connStatus.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-zinc-400"></span> <span>Waiting</span>';
      }
      const textConnStatus = document.getElementById('textConnectionStatus');
      if (textConnStatus) {
        textConnStatus.className = 'badge badge-secondary py-1 px-3';
        textConnStatus.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-zinc-400"></span> <span>Waiting</span>';
      }
      
      const welcome = document.getElementById('welcomeState');
      if (welcome) welcome.style.display = 'flex';

      const chatLog = document.getElementById('chatLog');
      if (chatLog) chatLog.innerHTML = '<div class="badge badge-secondary text-xs my-2 self-center">Call ended. Waiting for next partner...</div>';

      const textChatLog = document.getElementById('textChatLog');
      if (textChatLog) textChatLog.innerHTML = '<div id="welcomeState" class="absolute inset-0 flex flex-col items-center justify-center text-zinc-500 opacity-70 pointer-events-none"><i class="far fa-comments text-5xl mb-3 text-indigo-400/60"></i><p class="font-semibold text-base text-zinc-300">Ready to meet someone new?</p><p class="text-xs text-zinc-500 mt-1">Hit Skip or Start to begin matching.</p></div>';
    }
  }

  startCallTimer() {
    this.callStartTime = Date.now();
    const timerEl = document.getElementById('callTimer');
    const displayEl = document.getElementById('callTimerDisplay');
    const textTimerEl = document.getElementById('textCallTimer');

    if (timerEl) timerEl.classList.remove('hidden');
    if (textTimerEl) textTimerEl.classList.remove('hidden');

    if (this.callTimerInterval) clearInterval(this.callTimerInterval);

    this.callTimerInterval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - this.callStartTime) / 1000);
      const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
      const secs = String(elapsedSec % 60).padStart(2, '0');
      const formatted = `${mins}:${secs}`;
      if (displayEl) {
        displayEl.textContent = formatted;
      } else if (timerEl) {
        timerEl.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse mr-1"></span><span>${formatted}</span>`;
      }
      if (textTimerEl) textTimerEl.textContent = `• ${formatted}`;
    }, 1000);
  }

  // 5. Chat & Reactions
  sendMessage() {
    const input = this.selectedMode === 'text' 
      ? document.getElementById('textChatInput') 
      : document.getElementById('chatInput');
    
    if (!input) return;
    const text = input.value.trim();
    if (!text || !this.currentRoomId) return;

    this.socket.emit('send-message', {
      text,
      roomId: this.currentRoomId
    });
    input.value = '';
    this.sendTyping(false);
  }

  sendTyping(isTyping) {
    if (this.currentRoomId) {
      this.socket.emit('typing', {
        isTyping,
        roomId: this.currentRoomId
      });
    }
  }

  sendReaction(emoji) {
    if (this.currentRoomId) {
      this.socket.emit('send-reaction', {
        emoji,
        roomId: this.currentRoomId
      });
    }
  }

  renderMessage(msg) {
    const isMine = msg.senderId === this.socket.id;
    const targets = [document.getElementById('chatLog'), document.getElementById('textChatLog')];
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Hide welcome state
    const welcome = document.getElementById('welcomeState');
    if (welcome) welcome.style.display = 'none';

    targets.forEach(container => {
      if (!container) return;

      const row = document.createElement('div');
      row.className = 'chat-bubble-row';

      if (isMine) {
        row.innerHTML = `
          <div class="chat-bubble-mine">
            <div>${this.escapeHTML(msg.text)}</div>
            <div style="font-size: 10px; opacity: 0.75; text-align: right; margin-top: 3px;">${time}</div>
          </div>
        `;
      } else {
        const partnerAvatarSrc = getAvatarSrc(this.partner?.avatar);
        row.innerHTML = `
          <div class="chat-bubble-stranger-wrap">
            <div class="stranger-avatar-badge overflow-hidden w-7 h-7 rounded-full border border-white/10 flex-shrink-0">
              <img src="${partnerAvatarSrc}" class="w-full h-full object-cover" alt="Stranger" />
            </div>
            <div class="chat-bubble-stranger">
              <div>${this.escapeHTML(msg.text)}</div>
              <div style="font-size: 10px; opacity: 0.6; text-align: right; margin-top: 3px;">${time}</div>
            </div>
          </div>
        `;
      }

      container.appendChild(row);
      container.scrollTop = container.scrollHeight;
    });
  }

  escapeHTML(str) {
    return str.replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }

  addSystemMessage(text) {
    const targets = [document.getElementById('chatLog'), document.getElementById('textChatLog')];
    targets.forEach(container => {
      if (!container) return;
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble-system my-1 mx-auto';
      bubble.textContent = text;
      container.appendChild(bubble);
      container.scrollTop = container.scrollHeight;
    });
  }

  showFloatingReaction(emoji) {
    const stage = document.getElementById('screen-call') || document.body;
    const el = document.createElement('div');
    el.textContent = emoji;
    el.style.position = 'fixed';
    el.style.left = `${30 + Math.random() * 40}%`;
    el.style.bottom = '100px';
    el.style.fontSize = '2.5rem';
    el.style.zIndex = '100';
    el.style.transition = 'all 1.2s cubic-bezier(0.2, 0.8, 0.2, 1)';
    el.style.pointerEvents = 'none';

    stage.appendChild(el);

    requestAnimationFrame(() => {
      el.style.transform = `translateY(-180px) scale(1.4) rotate(${Math.random() * 40 - 20}deg)`;
      el.style.opacity = '0';
    });

    setTimeout(() => el.remove(), 1200);
  }

  // 6. Mini-Games & Icebreakers
  openGameModal(gameType = 'tictactoe', isMyTurn = true) {
    const modal = document.getElementById('modal-games');
    if (!modal) return;
    modal.classList.add('active');

    if (gameType === 'tictactoe') {
      this.gameManager.startTicTacToe(isMyTurn);
      document.getElementById('ttt-game-container').style.display = 'block';
      document.getElementById('rps-game-container').style.display = 'none';
    } else {
      this.gameManager.startRPS();
      document.getElementById('ttt-game-container').style.display = 'none';
      document.getElementById('rps-game-container').style.display = 'block';
    }
    this.refreshIcons();
  }

  renderGameState(state) {
    if (state.game === 'tictactoe') {
      const statusEl = document.getElementById('ttt-status');
      if (state.winner) {
        statusEl.textContent = state.winner === state.mySymbol ? '🎉 You Won!' : 'Partner Won!';
      } else if (state.isDraw) {
        statusEl.textContent = '🤝 Game Draw!';
      } else {
        statusEl.textContent = state.myTurn ? '👉 Your Turn' : 'Partner Thinking...';
      }

      state.board.forEach((val, idx) => {
        const cell = document.getElementById(`ttt-cell-${idx}`);
        if (cell) {
          cell.textContent = val || '';
          cell.style.color = val === 'X' ? '#818cf8' : '#f43f5e';
        }
      });
    } else if (state.game === 'rps') {
      const statusEl = document.getElementById('rps-status');
      const scoreEl = document.getElementById('rps-score');

      if (scoreEl) scoreEl.textContent = `You ${state.scores.me} - ${state.scores.partner} Partner`;

      if (state.result) {
        if (state.result === 'win') statusEl.textContent = `🎉 You Win! (${state.myChoice} vs ${state.partnerChoice})`;
        else if (state.result === 'lose') statusEl.textContent = `Partner Wins! (${state.myChoice} vs ${state.partnerChoice})`;
        else statusEl.textContent = `🤝 Tie! Both chose ${state.myChoice}`;
      } else {
        statusEl.textContent = state.myChoice ? 'Waiting for partner...' : 'Pick your weapon!';
      }
    }
  }

  drawNewIcebreaker() {
    const q = this.gameManager.getRandomIcebreaker();
    document.getElementById('icebreaker-question-text').textContent = q;
    this.gameManager.shareIcebreaker(q);
  }

  showIcebreakerModal(question, senderName) {
    const modal = document.getElementById('modal-icebreaker');
    if (!modal) return;
    document.getElementById('icebreaker-question-text').textContent = question;
    document.getElementById('icebreaker-sender-badge').textContent = `Shared by ${senderName}`;
    modal.classList.add('active');
    this.refreshIcons();
  }

  // 7. Friends & Reconnect
  sendFriendRequest() {
    if (!this.currentRoomId) return;
    this.socket.emit('send-friend-request');
    this.showToast('Friend request sent!');
  }

  showFriendRequestModal(data) {
    const accepted = confirm(`${data.friendName} wants to add you as a Friend on MTalk! Accept?`);
    if (accepted) {
      this.socket.emit('accept-friend-request', data);
    }
  }

  async loadFriendsList() {
    if (!this.sessionToken) return;
    try {
      const res = await fetch(`/api/friends/${this.sessionToken}`);
      const friends = await res.json();
      const listEl = document.getElementById('friends-list-container');
      if (!listEl) return;

      listEl.innerHTML = '';
      if (friends.length === 0) {
        listEl.innerHTML = '<div style="text-align:center; color:#64748b; padding:20px;">No friends saved yet. Click "Add Friend" during a call!</div>';
        return;
      }

      friends.forEach(f => {
        const row = document.createElement('div');
        row.className = 'friend-item-row';
        row.innerHTML = `
          <div class="friend-info">
            <span class="friend-status-dot ${f.online ? 'online' : ''}"></span>
            <span style="font-weight:700;">${f.friend_name}</span>
          </div>
          <button class="btn-call-friend" data-token="${f.friend_token}">
            ${f.online ? '📞 Call' : 'Offline'}
          </button>
        `;
        const callBtn = row.querySelector('.btn-call-friend');
        if (f.online) {
          callBtn.onclick = () => {
            document.getElementById('modal-friends').classList.remove('active');
            this.socket.emit('direct-call-friend', { friendToken: f.friend_token, mode: 'voice' });
            this.showToast(`Calling ${f.friend_name}...`);
          };
        } else {
          callBtn.style.opacity = '0.5';
          callBtn.disabled = true;
        }
        listEl.appendChild(row);
      });
    } catch (e) {
      console.error('Error loading friends:', e);
    }
  }

  showIncomingCallModal(data) {
    window.SoundEffects.playMatchFound();
    const accepted = confirm(`📞 Incoming ${data.mode} call from ${data.callerName}! Accept?`);
    if (accepted) {
      this.socket.emit('accept-direct-call', {
        callerSocketId: data.callerSocketId,
        callerToken: data.callerToken
      });
    }
  }

  // 8. Screen & UI Switching
  showScreen(screenName) {
    document.querySelectorAll('.view-screen').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(`screen-${screenName}`);
    if (target) target.classList.add('active');

    // Show/hide mobile chat toggle in header depending on screen
    const chatToggle = document.getElementById('mobileChatToggle');
    if (chatToggle) {
      if (screenName === 'call') {
        chatToggle.style.display = 'flex';
      } else {
        chatToggle.style.display = 'none';
      }
    }

    // Toggle mobile header visibility
    const header = document.querySelector('.app-header');
    if (header) {
      if (screenName === 'call' || screenName === 'text') {
        header.classList.add('mobile-header-hidden');
      } else {
        header.classList.remove('mobile-header-hidden');
      }
    }

    this.refreshIcons();
  }

  setupInCallPartnerUI() {
    const nickname = this.partner?.nickname || 'Stranger';
    const avatar   = this.partner?.avatar   || '👤';

    const countryMap = {
      'GLOBAL': '🌍', 'US': '🇺🇸', 'GB': '🇬🇧', 'CA': '🇨🇦', 'DE': '🇩🇪',
      'FR': '🇫🇷', 'JP': '🇯🇵', 'IN': '🇮🇳', 'BR': '🇧🇷', 'AU': '🇦🇺'
    };
    const flag = countryMap[this.partner?.country] || '🌍';

    const textConnStatus = document.getElementById('textConnectionStatus');
    if (textConnStatus) {
      textConnStatus.className = 'badge badge-emerald py-1 px-3';
      textConnStatus.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> <span>Connected</span>';
    }

    const noticeEl = document.getElementById('chatStatusNotice');
    if (noticeEl) noticeEl.textContent = 'You are chatting with a random stranger. Say hi!';
    const textNoticeEl = document.getElementById('textChatStatusNotice');
    if (textNoticeEl) textNoticeEl.textContent = 'You are chatting with a random stranger. Say hi!';

    // WhatsApp-Style Text Chat Header Info
    const textNick = document.getElementById('textPartnerNickname');
    const textFlag = document.getElementById('textPartnerFlag');
    const textAvatar = document.getElementById('textPartnerAvatar');
    const textStatus = document.getElementById('textPartnerStatus');
    const partnerAvatarSrc = getAvatarSrc(avatar);

    if (textNick) textNick.textContent = nickname;
    if (textFlag) textFlag.textContent = flag;
    if (textAvatar) {
      if (textAvatar.tagName === 'IMG') {
        textAvatar.src = partnerAvatarSrc;
      } else {
        textAvatar.innerHTML = `<img src="${partnerAvatarSrc}" class="w-full h-full object-cover rounded-full" alt="Stranger Avatar" />`;
      }
    }
    if (textStatus) textStatus.textContent = 'online';

    // Avatar fallback (voice mode / camera off)
    const pNick   = document.getElementById('partner-nickname');
    const pFlag   = document.getElementById('partner-flag');
    const pAvatar = document.getElementById('partner-voice-avatar');
    if (pNick)   pNick.textContent   = nickname;
    if (pFlag)   pFlag.textContent   = flag;
    if (pAvatar) {
      if (pAvatar.tagName === 'IMG') {
        pAvatar.src = partnerAvatarSrc;
      } else {
        pAvatar.innerHTML = `<img src="${partnerAvatarSrc}" class="w-full h-full object-cover rounded-full" alt="Stranger Avatar" />`;
      }
    }

    const strangerStatus = document.getElementById('strangerStatusText');
    if (strangerStatus) strangerStatus.textContent = `Connected with ${nickname}`;
  }

  updateUserProfileUI() {
    const nickEls = document.querySelectorAll('.user-display-nickname');
    nickEls.forEach(el => el.textContent = this.nickname);

    const avatarSrc = getAvatarSrc(this.avatar);
    const avatarEls = document.querySelectorAll('.user-display-avatar');
    avatarEls.forEach(el => {
      if (el.tagName === 'IMG') {
        el.src = avatarSrc;
      } else {
        el.innerHTML = `<img src="${avatarSrc}" class="w-full h-full object-cover rounded-full" alt="My Avatar" />`;
      }
    });

    const codeEl = document.getElementById('my-friend-code-display');
    if (codeEl && this.sessionToken) {
      codeEl.textContent = this.sessionToken.slice(0, 12);
    }
  }

  async loadStats() {
    try {
      const res = await fetch('/api/stats');
      const data = await res.json();
      const onlineEl = document.getElementById('stat-online-count');
      if (onlineEl) onlineEl.textContent = `${data.online.toLocaleString()} Online`;
    } catch (e) {
      console.log('Stats error:', e);
    }
  }

  async initTopics() {
    try {
      const res = await fetch('/api/topics');
      const topics = await res.json();
      const container = document.getElementById('topics-tags-container');
      if (!container) return;

      container.innerHTML = '';
      topics.forEach(t => {
        const tag = document.createElement('div');
        const isActive = this.selectedTopics.includes(t.id);
        tag.className = `topic-tag ${isActive ? 'active' : ''}`;
        tag.innerHTML = `<span>${t.icon}</span> <span>${t.name}</span>`;
        tag.onclick = () => {
          if (this.selectedTopics.includes(t.id)) {
            this.selectedTopics = this.selectedTopics.filter(id => id !== t.id);
            tag.classList.remove('active');
          } else {
            this.selectedTopics.push(t.id);
            tag.classList.add('active');
          }
          localStorage.setItem('mtalk_topics', JSON.stringify(this.selectedTopics));
        };
        container.appendChild(tag);
      });
    } catch (e) {
      console.log('Topics error:', e);
    }
  }

  // 9. Event Listeners
  initUIEventListeners() {
    // Mode selection cards
    document.querySelectorAll('.mode-card').forEach(card => {
      card.addEventListener('click', () => {
        document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedMode = card.dataset.mode || 'voice';
        window.SoundEffects.playButtonClick();
      });
    });

    // Big Rectangle START TALKING Button
    document.getElementById('btn-start-talk')?.addEventListener('click', () => {
      this.joinQueue(this.selectedMode);
    });

    // Filters Accordion Toggle
    const filtersHeader = document.getElementById('btn-toggle-filters');
    const filtersPanel = document.getElementById('filters-collapsible-panel');

    // On mobile, start collapsed by default
    if (window.innerWidth <= 768 && filtersPanel) {
      filtersPanel.classList.add('collapsed');
      filtersHeader?.classList.remove('expanded');
    } else if (filtersHeader) {
      filtersHeader.classList.add('expanded');
    }

    filtersHeader?.addEventListener('click', () => {
      if (filtersPanel) {
        filtersPanel.classList.toggle('collapsed');
        filtersHeader.classList.toggle('expanded');
      }
    });

    // Permission Modal Retry Button
    document.getElementById('btn-retry-permission')?.addEventListener('click', async () => {
      document.getElementById('modal-permission')?.classList.remove('active');
      const granted = await this.webrtc.checkAndRequestPermissions(this.selectedMode);
      if (granted) {
        this.joinQueue(this.selectedMode);
      } else {
        this.showToast('Microphone / Camera access is required.');
      }
    });

    // VIP Paid Modals Triggers
    const openVipModal = () => {
      document.getElementById('modal-vip')?.classList.add('active');
      this.refreshIcons();
    };

    document.getElementById('btn-open-vip')?.addEventListener('click', openVipModal);
    document.getElementById('btn-paid-country')?.addEventListener('click', openVipModal);
    document.getElementById('btn-paid-gender')?.addEventListener('click', openVipModal);

    // Unlock VIP Demo
    document.getElementById('btn-unlock-vip-pass')?.addEventListener('click', () => {
      this.isVip = true;
      localStorage.setItem('mtalk_is_vip', 'true');
      document.getElementById('modal-vip')?.classList.remove('active');
      this.showToast('👑 VIP Access Unlocked! You can now filter by Country & Gender.');

      const countryText = document.getElementById('selected-country-text');
      if (countryText) countryText.textContent = '🇺🇸 United States (VIP Active)';

      const genderText = document.getElementById('selected-gender-text');
      if (genderText) genderText.textContent = '👩 Female Only (VIP Active)';
    });

    // Radar Cancel
    document.getElementById('btn-cancel-radar')?.addEventListener('click', () => {
      this.cancelQueue();
    });

    // In-Call Overlay Buttons
    document.getElementById('btn-overlay-skip')?.addEventListener('click', () => {
      this.nextStranger();
    });

    document.getElementById('btn-overlay-cancel')?.addEventListener('click', () => {
      this.hangUpCall();
    });

    // Auto-Next Checkboxes
    const syncAutoNext = (val) => {
      this.autoNext = val;
      localStorage.setItem('mtalk_auto_next', String(this.autoNext));
      const el1 = document.getElementById('autoNextToggle');
      const el2 = document.getElementById('textAutoNextToggle');
      const el3 = document.getElementById('toggle-auto-next');
      if (el1) el1.checked = val;
      if (el2) el2.checked = val;
      if (el3) el3.checked = val;
      this.showToast(this.autoNext ? '⚡ Auto-Next Enabled' : 'Auto-Next Disabled');
    };

    document.getElementById('autoNextToggle')?.addEventListener('change', (e) => syncAutoNext(e.target.checked));
    document.getElementById('textAutoNextToggle')?.addEventListener('change', (e) => syncAutoNext(e.target.checked));
    document.getElementById('toggle-auto-next')?.addEventListener('change', (e) => syncAutoNext(e.target.checked));

    // Call Actions: Skip / Next Stranger
    document.getElementById('mainActionBtn')?.addEventListener('click', () => this.nextStranger());
    document.getElementById('textMainActionBtn')?.addEventListener('click', () => this.nextStranger());
    document.getElementById('btn-skip-partner')?.addEventListener('click', () => this.nextStranger());
    document.getElementById('btn-text-skip')?.addEventListener('click', () => this.nextStranger());

    // Disconnect / Hang Up
    document.getElementById('stopBtn')?.addEventListener('click', () => this.hangUpCall());
    document.getElementById('textStopBtn')?.addEventListener('click', () => this.hangUpCall());
    document.getElementById('btn-hangup-call')?.addEventListener('click', () => this.hangUpCall());
    document.getElementById('btn-text-leave')?.addEventListener('click', () => this.hangUpCall());

    // Mute toggle
    const handleMuteToggle = () => {
      const isMuted = this.webrtc.toggleMute();
      const btn = document.getElementById('toggleMicBtn') || document.getElementById('btn-toggle-mute');
      if (btn) {
        if (isMuted) {
          btn.classList.add('bg-red-500/20', 'text-red-400');
          btn.title = 'Unmute Microphone';
          btn.innerHTML = '<i class="fas fa-microphone-slash text-lg"></i>';
        } else {
          btn.classList.remove('bg-red-500/20', 'text-red-400');
          btn.title = 'Mute Microphone';
          btn.innerHTML = '<i class="fas fa-microphone text-lg"></i>';
        }
      }
    };
    document.getElementById('toggleMicBtn')?.addEventListener('click', handleMuteToggle);
    document.getElementById('btn-toggle-mute')?.addEventListener('click', handleMuteToggle);

    // Video toggle
    const handleVideoToggle = () => {
      const isOff = this.webrtc.toggleVideo();
      const btn = document.getElementById('toggleCamBtn') || document.getElementById('btn-toggle-video');
      const videoEl = document.getElementById('localVideo') || document.getElementById('local-video');
      const avatarEl = document.getElementById('localAvatar');
      if (btn) {
        if (isOff) {
          btn.classList.add('bg-red-500/20', 'text-red-400');
          btn.innerHTML = '<i class="fas fa-video-slash text-lg"></i>';
          if (videoEl) videoEl.style.opacity = '0';
          if (avatarEl) avatarEl.style.opacity = '1';
        } else {
          btn.classList.remove('bg-red-500/20', 'text-red-400');
          btn.innerHTML = '<i class="fas fa-video text-lg"></i>';
          if (videoEl) videoEl.style.opacity = '1';
          if (avatarEl) avatarEl.style.opacity = '0';
        }
      }
    };
    document.getElementById('toggleCamBtn')?.addEventListener('click', handleVideoToggle);
    document.getElementById('btn-toggle-video')?.addEventListener('click', handleVideoToggle);

    // Flip camera (mobile)
    document.getElementById('btn-flip-camera')?.addEventListener('click', async () => {
      const newStream = await this.webrtc.flipCamera();
      if (newStream) {
        const localVideo = document.getElementById('localVideo') || document.getElementById('local-video');
        if (localVideo) localVideo.srcObject = newStream;
      }
    });

    // Speaker toggle
    document.getElementById('btn-toggle-speaker')?.addEventListener('click', () => {
      const isSpeakerMuted = this.webrtc.toggleSpeaker();
      const btn = document.getElementById('btn-toggle-speaker');
      if (btn) {
        if (isSpeakerMuted) {
          btn.classList.add('bg-red-500/20', 'text-red-400');
          btn.innerHTML = '<i class="fas fa-volume-mute text-lg"></i>';
          this.showToast('Speaker Muted');
        } else {
          btn.classList.remove('bg-red-500/20', 'text-red-400');
          btn.innerHTML = '<i class="fas fa-volume-up text-lg"></i>';
          this.showToast('Speaker Unmuted');
        }
      }
    });

    // Mobile Chat Drawer Toggle
    const toggleMobileChatDrawer = (open) => {
      const sidebar = document.getElementById('chatSidebar');
      const overlay = document.getElementById('chatOverlay');
      if (sidebar) {
        if (open) {
          sidebar.classList.remove('chat-panel-mobile-hidden');
          sidebar.classList.add('chat-panel-mobile-visible');
          if (overlay) overlay.classList.remove('hidden');
          document.getElementById('chat-unread-dot')?.classList.remove('active');
          document.getElementById('chat-mobile-dot')?.classList.remove('active');
        } else {
          sidebar.classList.remove('chat-panel-mobile-visible');
          sidebar.classList.add('chat-panel-mobile-hidden');
          if (overlay) overlay.classList.add('hidden');
        }
      }
    };

    document.getElementById('mobileChatToggle')?.addEventListener('click', () => toggleMobileChatDrawer(true));
    document.getElementById('openChatBtn')?.addEventListener('click', () => toggleMobileChatDrawer(true));
    document.getElementById('closeChatBtn')?.addEventListener('click', () => toggleMobileChatDrawer(false));
    document.getElementById('chatOverlay')?.addEventListener('click', () => toggleMobileChatDrawer(false));

    // Add Friend
    document.getElementById('btn-add-friend')?.addEventListener('click', () => this.sendFriendRequest());
    document.getElementById('btn-text-add-friend')?.addEventListener('click', () => this.sendFriendRequest());
    document.getElementById('btn-open-friends')?.addEventListener('click', () => {
      this.loadFriendsList();
      document.getElementById('modal-friends')?.classList.add('active');
      this.refreshIcons();
    });

    // Mini-Games Modal Trigger
    const triggerGames = () => {
      const gameType = prompt('Choose game:\n1. Tic-Tac-Toe\n2. Rock-Paper-Scissors', '1') === '2' ? 'rps' : 'tictactoe';
      this.socket.emit('game-start-request', { gameType });
      this.showToast('Game invitation sent to partner!');
    };
    document.getElementById('btn-open-games')?.addEventListener('click', triggerGames);
    document.getElementById('btn-text-games')?.addEventListener('click', triggerGames);

    // Tic-Tac-Toe cell clicks
    for (let i = 0; i < 9; i++) {
      document.getElementById(`ttt-cell-${i}`)?.addEventListener('click', () => {
        this.gameManager.makeTicTacToeMove(i);
      });
    }

    // RPS buttons
    document.querySelectorAll('.rps-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const choice = btn.dataset.choice;
        this.gameManager.makeRPSChoice(choice);
      });
    });

    // Icebreaker trigger
    const triggerIcebreaker = () => {
      this.drawNewIcebreaker();
      document.getElementById('modal-icebreaker')?.classList.add('active');
      this.refreshIcons();
    };
    document.getElementById('btn-open-icebreaker')?.addEventListener('click', triggerIcebreaker);
    document.getElementById('btn-text-icebreaker')?.addEventListener('click', triggerIcebreaker);
    document.getElementById('btn-draw-next-icebreaker')?.addEventListener('click', () => this.drawNewIcebreaker());

    // In-Call Search Overlay Cancel
    document.getElementById('btn-overlay-cancel')?.addEventListener('click', () => {
      this.hangUpCall();
    });

    // Chat Inputs & Sending
    const attachChatInput = (inputEl, sendBtnEl) => {
      if (!inputEl) return;
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.sendMessage();
        } else {
          this.sendTyping(true);
          if (this.typingTimeout) clearTimeout(this.typingTimeout);
          this.typingTimeout = setTimeout(() => this.sendTyping(false), 2000);
        }
      });
      sendBtnEl?.addEventListener('click', () => this.sendMessage());
    };

    attachChatInput(document.getElementById('chatInput'), document.getElementById('sendBtn'));
    attachChatInput(document.getElementById('textChatInput'), document.getElementById('textSendBtn'));

    // Reaction clicks
    document.querySelectorAll('.reaction-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.sendReaction(btn.textContent.trim());
      });
    });

    // Global keyboard shortcut: ESC to skip partner when in call
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isInCall && !document.querySelector('.modal-overlay.active')) {
        this.nextStranger();
      }
    });

    // Modals Close buttons & backdrop click to close
    document.querySelectorAll('.modal-close-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.modal-overlay')?.classList.remove('active');
      });
    });

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.classList.remove('active');
        }
      });
    });

    // Profile Edit Modal
    document.getElementById('user-profile-pill')?.addEventListener('click', () => {
      document.getElementById('input-edit-nickname').value = this.nickname;
      document.querySelectorAll('.avatar-option-btn').forEach(b => {
        const isSelected = (b.dataset.avatar === this.avatar) || (b.dataset.avatar === 'avatar-fox' && !this.avatar);
        b.style.borderColor = isSelected ? '#6366f1' : 'transparent';
      });
      document.getElementById('modal-profile')?.classList.add('active');
      this.refreshIcons();
    });

    document.getElementById('btn-save-profile')?.addEventListener('click', () => {
      const newNick = document.getElementById('input-edit-nickname').value.trim();
      if (newNick) this.nickname = newNick;

      localStorage.setItem('mtalk_nickname', this.nickname);
      localStorage.setItem('mtalk_avatar', this.avatar);
      this.updateUserProfileUI();
      this.socket.emit('init-session', {
        sessionToken: this.sessionToken,
        nickname: this.nickname,
        avatar: this.avatar,
        country: this.country,
        gender: this.gender,
        topics: this.selectedTopics
      });
      document.getElementById('modal-profile')?.classList.remove('active');
      this.showToast('Profile saved!');
    });

    // Avatar selector clicks
    document.querySelectorAll('.avatar-option-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.avatar-option-btn').forEach(b => b.style.borderColor = 'transparent');
        btn.style.borderColor = '#6366f1';
        this.avatar = btn.dataset.avatar || 'avatar-fox';
        localStorage.setItem('mtalk_avatar', this.avatar);
      });
    });

    // Report User Modal
    const triggerReport = () => {
      document.getElementById('modal-report')?.classList.add('active');
      this.refreshIcons();
    };
    document.getElementById('btn-open-report')?.addEventListener('click', triggerReport);
    document.getElementById('btn-text-report')?.addEventListener('click', triggerReport);

    document.getElementById('btn-submit-report')?.addEventListener('click', async () => {
      const reason = document.getElementById('report-reason-select').value;
      const details = document.getElementById('report-details-input').value;

      await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reporterToken: this.sessionToken,
          reportedToken: this.partner?.sessionToken,
          reason,
          details
        })
      });

      document.getElementById('modal-report')?.classList.remove('active');
      this.showToast('Report submitted. Skipping user...');
      this.nextStranger();
    });

    // Copy Friend Code
    document.getElementById('btn-copy-friend-code')?.addEventListener('click', () => {
      if (this.sessionToken) {
        navigator.clipboard.writeText(this.sessionToken);
        this.showToast('Friend Reconnect Code copied to clipboard!');
      }
    });
  }

  // 10. Mobile Touch Gestures & Wake Lock
  setupMobileGestures() {
    let touchStartY = 0;
    const stage = document.getElementById('call-media-stage');

    stage?.addEventListener('touchstart', (e) => {
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    stage?.addEventListener('touchend', (e) => {
      const touchEndY = e.changedTouches[0].clientY;
      const diffY = touchStartY - touchEndY;

      // Swipe Up (> 80px) to skip stranger
      if (diffY > 80 && this.isInCall) {
        this.nextStranger();
      }
    }, { passive: true });
  }

  async requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
      } catch (err) {
        console.log('WakeLock error:', err);
      }
    }
  }

  releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().catch(e => console.log(e));
      this.wakeLock = null;
    }
  }

  showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.textContent = message;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(() => toast.remove(), 300);
    }, 2800);
  }
}

// Instantiate on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new MTalkApp();
});
