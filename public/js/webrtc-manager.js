/**
 * MTalk WebRTC Connection Manager
 * High-reliability RTCPeerConnection with Google, Mozilla STUN & OpenRelay TURN servers,
 * Symmetric NAT & Multi-Wi-Fi traversal, Promise-coordinated media acquisition,
 * race-condition free Offer/Answer exchange, ICE candidate buffering, automatic ICE restart,
 * and reliable remote track attachment.
 */

const RTC_CONFIG = {
  iceServers: [
    // Primary Google Public STUN
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },

    // Mozilla & Cloudflare Public STUN
    { urls: 'stun:stun.services.mozilla.com' },
    { urls: 'stun:stun.cloudflare.com:3478' },

    // Sipgate Public STUN
    { urls: 'stun:stun.sipgate.net:10000' },

    // Free OpenRelay / Metered TURN Relay Servers (Handles Symmetric NAT & Cross-Wi-Fi)
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
  ],
  iceCandidatePoolSize: 10,
  iceTransportPolicy: 'all',
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

class WebRTCManager {
  constructor(socket) {
    this.socket = socket;
    this.peerConnection = null;
    this.dataChannel = null;
    this.localStream = null;
    this.remoteStream = null;
    this.mode = 'voice'; // 'voice', 'video', 'text'
    this.facingMode = 'user'; // 'user' or 'environment'
    this.isMuted = false;
    this.isVideoOff = false;
    this.isSpeakerMuted = false;
    this.roomId = null;
    this.rtcConfig = { ...RTC_CONFIG };

    // Async lock for media acquisition
    this.mediaPromise = null;

    // Buffer ICE candidates if they arrive before setRemoteDescription
    this.iceCandidateQueue = [];
    this.hasRemoteDescription = false;
    this.isMakingOffer = false;

    // Callbacks
    this.onRemoteStream = null;
    this.onConnectionStateChange = null;
    this.onDataChannelMessage = null;

    // Fetch dynamic server ICE configs
    this.fetchIceServers();
  }

  async fetchIceServers() {
    try {
      const res = await fetch('/api/ice-servers');
      if (res.ok) {
        const data = await res.json();
        if (data && data.iceServers && data.iceServers.length > 0) {
          this.rtcConfig.iceServers = data.iceServers;
          console.log('[WebRTC] Dynamic STUN/TURN servers loaded:', data.iceServers.length);
        }
      }
    } catch (e) {
      console.warn('[WebRTC] Could not fetch dynamic ICE servers, using built-in defaults:', e);
    }
  }

  setRoomId(roomId) {
    this.roomId = roomId;
  }

  async checkAndRequestPermissions(mode = 'voice') {
    this.mode = mode;
    if (mode === 'text') return true;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.warn('[WebRTC] getUserMedia is not supported or requires HTTPS on remote devices.');
      return false;
    }

    const needsVideo = mode === 'video';
    const hasAudioTrack = this.localStream && this.localStream.getAudioTracks().some(t => t.readyState === 'live');
    const hasVideoTrack = this.localStream && this.localStream.getVideoTracks().some(t => t.readyState === 'live');

    if (this.localStream && hasAudioTrack && (!needsVideo || hasVideoTrack)) {
      return true;
    }

    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: needsVideo ? {
        facingMode: this.facingMode,
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        frameRate: { ideal: 30, max: 30 }
      } : false
    };

    try {
      if (this.localStream) {
        this.stopLocalMedia();
      }
      this.mediaPromise = navigator.mediaDevices.getUserMedia(constraints);
      this.localStream = await this.mediaPromise;
      this.mediaPromise = null;
      return true;
    } catch (err) {
      console.warn('[WebRTC] Permission or device error:', err);
      if (needsVideo) {
        try {
          this.mediaPromise = navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          this.localStream = await this.mediaPromise;
          this.mediaPromise = null;
          return 'audio_only';
        } catch (e2) {
          console.error('[WebRTC] Audio permission also denied:', e2);
          this.mediaPromise = null;
          return false;
        }
      }
      this.mediaPromise = null;
      return false;
    }
  }

  async getLocalMedia(mode = 'voice') {
    if (this.mediaPromise) {
      await this.mediaPromise;
    }
    const needsVideo = mode === 'video';
    const hasAudio = this.localStream && this.localStream.getAudioTracks().some(t => t.readyState === 'live');
    const hasVideo = this.localStream && this.localStream.getVideoTracks().some(t => t.readyState === 'live');

    if (this.localStream && hasAudio && (!needsVideo || hasVideo)) {
      return this.localStream;
    }
    const ok = await this.checkAndRequestPermissions(mode);
    if (ok) return this.localStream;
    return null;
  }

  createPeerConnection(isInitiator) {
    if (this.peerConnection && this.peerConnection.signalingState !== 'closed') {
      this.attachLocalTracksToPeer();
      return this.peerConnection;
    }

    this.closePeerConnection();

    console.log('[WebRTC] Creating RTCPeerConnection (Initiator:', isInitiator, ')');
    const configToUse = this.rtcConfig || RTC_CONFIG;
    try {
      this.peerConnection = new RTCPeerConnection(configToUse);
    } catch (e) {
      console.warn('[WebRTC] Primary RTC_CONFIG warning, using fallback:', e);
      this.peerConnection = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      });
    }
    this.remoteStream = new MediaStream();
    this.iceCandidateQueue = [];
    this.hasRemoteDescription = false;

    // Attach local tracks if already available
    this.attachLocalTracksToPeer();

    // Handle remote tracks
    this.peerConnection.ontrack = (event) => {
      console.log('[WebRTC] ontrack received:', event.track.kind, event.streams);
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
      }

      if (event.streams && event.streams[0]) {
        event.streams[0].getTracks().forEach(track => {
          if (!this.remoteStream.getTracks().some(t => t.id === track.id)) {
            this.remoteStream.addTrack(track);
          }
        });
      } else if (event.track) {
        if (!this.remoteStream.getTracks().some(t => t.id === event.track.id)) {
          this.remoteStream.addTrack(event.track);
        }
      }

      if (this.onRemoteStream) {
        this.onRemoteStream(this.remoteStream);
      }
    };

    // ICE Candidates
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.socket && this.roomId) {
        console.log('[WebRTC] Local ICE candidate gathered');
        this.socket.emit('signal-ice-candidate', {
          candidate: event.candidate,
          roomId: this.roomId
        });
      }
    };

    // ICE Connection state & Auto Restart
    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection ? this.peerConnection.iceConnectionState : 'closed';
      console.log('[WebRTC] ICE Connection state:', state);
      if (state === 'failed' && this.peerConnection) {
        console.warn('[WebRTC] ICE failed. Attempting ICE restart...');
        if (isInitiator) {
          this.createOffer(true).catch(e => console.error('[WebRTC] ICE restart error:', e));
        }
      }
    };

    // Peer Connection State
    this.peerConnection.onconnectionstatechange = () => {
      if (!this.peerConnection) return;
      const state = this.peerConnection.connectionState;
      console.log('[WebRTC] Peer Connection state:', state);
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(state);
      }
    };

    // Data Channel for fast P2P messaging & game moves
    if (isInitiator) {
      try {
        this.dataChannel = this.peerConnection.createDataChannel('mtalk-datachannel', {
          ordered: true
        });
        this.setupDataChannel(this.dataChannel);
      } catch (e) {
        console.warn('[WebRTC] DataChannel error:', e);
      }
    } else {
      this.peerConnection.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.setupDataChannel(this.dataChannel);
      };
    }

    return this.peerConnection;
  }

  attachLocalTracksToPeer() {
    if (!this.peerConnection || !this.localStream) return;
    const senders = this.peerConnection.getSenders();
    this.localStream.getTracks().forEach(track => {
      const sender = senders.find(s => s.track && s.track.kind === track.kind);
      if (sender) {
        if (sender.track !== track) {
          sender.replaceTrack(track).catch(e => console.warn('[WebRTC] Replace track error:', e));
        }
      } else {
        try {
          this.peerConnection.addTrack(track, this.localStream);
          console.log('[WebRTC] Attached local track:', track.kind);
        } catch (e) {
          console.warn('[WebRTC] Add track warning:', e);
        }
      }
    });
  }

  setupDataChannel(dc) {
    dc.onopen = () => console.log('[WebRTC] DataChannel opened');
    dc.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (this.onDataChannelMessage) {
          this.onDataChannelMessage(data);
        }
      } catch (e) {
        console.warn('[WebRTC] DataChannel JSON parse warning:', e);
      }
    };
  }

  sendDataChannelMessage(payload) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      try {
        this.dataChannel.send(JSON.stringify(payload));
        return true;
      } catch (e) {
        console.warn('[WebRTC] DataChannel send error:', e);
      }
    }
    return false;
  }

  async createOffer(isRestart = false) {
    if (this.isMakingOffer) return;
    this.isMakingOffer = true;
    try {
      await this.getLocalMedia(this.mode);
      if (!this.peerConnection || this.peerConnection.signalingState === 'closed') {
        this.createPeerConnection(true);
      }
      this.attachLocalTracksToPeer();

      const offerOptions = {
        offerToReceiveAudio: true,
        offerToReceiveVideo: this.mode === 'video',
        iceRestart: isRestart
      };

      const offer = await this.peerConnection.createOffer(offerOptions);
      await this.peerConnection.setLocalDescription(offer);

      console.log('[WebRTC] Sending offer (Restart:', isRestart, ')');
      this.socket.emit('signal-offer', {
        offer,
        roomId: this.roomId
      });
    } catch (err) {
      console.error('[WebRTC] Create offer error:', err);
    } finally {
      this.isMakingOffer = false;
    }
  }

  async handleOffer(offer) {
    try {
      console.log('[WebRTC] Handling offer...');
      await this.getLocalMedia(this.mode);
      if (!this.peerConnection || this.peerConnection.signalingState === 'closed') {
        this.createPeerConnection(false);
      }
      this.attachLocalTracksToPeer();

      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      this.hasRemoteDescription = true;
      await this.flushIceCandidates();

      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);

      console.log('[WebRTC] Sending answer...');
      this.socket.emit('signal-answer', {
        answer,
        roomId: this.roomId
      });
    } catch (err) {
      console.error('[WebRTC] Handle offer error:', err);
    }
  }

  async handleAnswer(answer) {
    if (!this.peerConnection || this.peerConnection.signalingState === 'closed') return;
    if (this.peerConnection.signalingState !== 'have-local-offer') {
      console.warn('[WebRTC] Skipping handleAnswer, current signalingState:', this.peerConnection.signalingState);
      return;
    }
    try {
      console.log('[WebRTC] Setting remote description from answer...');
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      this.hasRemoteDescription = true;
      await this.flushIceCandidates();
    } catch (err) {
      console.error('[WebRTC] Handle answer error:', err);
    }
  }

  async handleIceCandidate(candidate) {
    if (!candidate) return;
    if (!this.peerConnection || !this.hasRemoteDescription || !this.peerConnection.remoteDescription || this.peerConnection.signalingState === 'closed') {
      this.iceCandidateQueue.push(candidate);
      return;
    }
    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('[WebRTC] Add ICE candidate warning:', err);
    }
  }

  async flushIceCandidates() {
    if (!this.peerConnection || !this.hasRemoteDescription || !this.peerConnection.remoteDescription) return;
    const candidates = [...this.iceCandidateQueue];
    this.iceCandidateQueue = [];
    for (const candidate of candidates) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('[WebRTC] Flushing candidate warning:', err);
      }
    }
  }

  toggleMute() {
    if (!this.localStream) return this.isMuted;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      this.isMuted = !this.isMuted;
      audioTrack.enabled = !this.isMuted;
    }
    return this.isMuted;
  }

  toggleVideo() {
    if (!this.localStream) return this.isVideoOff;
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (videoTrack) {
      this.isVideoOff = !this.isVideoOff;
      videoTrack.enabled = !this.isVideoOff;
    }
    return this.isVideoOff;
  }

  toggleSpeaker() {
    this.isSpeakerMuted = !this.isSpeakerMuted;
    const remoteAudio = document.getElementById('remote-audio-sink');
    if (remoteAudio) remoteAudio.muted = this.isSpeakerMuted;
    return this.isSpeakerMuted;
  }

  async flipCamera() {
    if (this.mode !== 'video' || !this.localStream) return;
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: this.facingMode }
      });
      const newVideoTrack = newStream.getVideoTracks()[0];
      const oldVideoTrack = this.localStream.getVideoTracks()[0];

      if (oldVideoTrack) {
        this.localStream.removeTrack(oldVideoTrack);
        oldVideoTrack.stop();
      }
      this.localStream.addTrack(newVideoTrack);

      if (this.peerConnection) {
        const sender = this.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
          sender.replaceTrack(newVideoTrack);
        }
      }
      return this.localStream;
    } catch (err) {
      console.error('[WebRTC] Error flipping camera:', err);
      return null;
    }
  }

  stopLocalMedia() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
  }

  closePeerConnection() {
    if (this.dataChannel) {
      try { this.dataChannel.close(); } catch (e) {}
      this.dataChannel = null;
    }
    if (this.peerConnection) {
      try { this.peerConnection.close(); } catch (e) {}
      this.peerConnection = null;
    }
    this.hasRemoteDescription = false;
    this.iceCandidateQueue = [];
    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach(t => t.stop());
      this.remoteStream = null;
    }
  }

  reset() {
    this.closePeerConnection();
    this.stopLocalMedia();
    this.isMuted = false;
    this.isVideoOff = false;
    this.isSpeakerMuted = false;
    this.roomId = null;
  }
}

window.WebRTCManager = WebRTCManager;
