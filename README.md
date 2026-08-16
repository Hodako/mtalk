# MTalk ⚡ - Real-Time Random Voice, Video & Text Chat

MTalk is a modern, high-performance, mobile-optimized random talking platform inspired by [Airtalk.live](https://airtalk.live). It allows users worldwide to anonymously connect 1-on-1 via WebRTC peer-to-peer audio, video, or instant messaging.

---

## 🌟 Key Features

1. **Random Matchmaking Queue**:
   - **Voice Only Call (Audio)**: Ultra-low latency voice talk with real-time waveform visualizers and speaking indicators.
   - **Video Call (Camera + Mic)**: HD face-to-face video chat with front/back mobile camera flipping.
   - **Text Chat Only**: Instant anonymous text chat with typing status, emoji quick reactions, and sound effects.
   - **Smart Filters**: Filter by Country/Region (with flags), Matching Preference (Any/Female/Male), and Interest/Topic Tags (Gaming, Music, Movies, Coding, Dating, Anime, etc.).
   - **Instant Next / Skip**: Seamlessly disconnect and pair with a new stranger with zero lag.

2. **In-Call Interactive Activities**:
   - **Tic-Tac-Toe**: Real-time synchronized 2-player board game.
   - **Rock-Paper-Scissors**: Interactive mini-game with score tracking.
   - **Icebreaker Deck**: 60+ curated questions & conversation starters to break the awkward silence.
   - **Friend Book**: Save connections with unique Reconnect Codes, see when friends are online, and call them directly.

3. **Audio Synthesis & Visualizers**:
   - Web Audio API synthesizer for match chimes, message pops, skip sounds, and disconnect tones (zero missing sound files).
   - Real-time spectrum audio wave equalizer that highlights the active speaker.

4. **Safety & Moderation**:
   - Abuse reporting modal with categorization.
   - Automatic profanity and spam sanitization.
   - IP blacklisting support stored in SQL database.

5. **Mobile-First Design**:
   - Dynamic viewport (`100dvh`) handling mobile navigation bars.
   - Swipe Up gesture to skip strangers.
   - Screen WakeLock API to keep phone display awake during calls.

---

## 🛠️ Architecture & Tech Stack

- **Backend**: Node.js, Express, Socket.IO, WebRTC Signaling Engine.
- **Frontend**: HTML5, Vanilla CSS3 (Custom Glassmorphism Design System), JavaScript (ES6+ Modules), Web Audio API, WebRTC RTCPeerConnection, RTCDataChannel.
- **Database**:
  - **SQLite** (Default, zero setup required, stored in `./data/mtalk.db`).
  - **PostgreSQL** supported out-of-the-box via `DATABASE_URL` in `.env`.

---

## 🚀 How to Run

### 1. Install Dependencies
```bash
npm install
```

### 2. Start MTalk Server
```bash
npm start
```
The server will bind to `0.0.0.0:3000` and be accessible publicly at `http://<your-public-ip>:3000`.

### 3. Environment Variables (Optional)
Create a `.env` file in the root folder:
```env
PORT=3000
# DATABASE_URL=postgresql://user:pass@localhost:5432/mtalk
```

### 4. Run Automated E2E Tests
```bash
node test_e2e_match.js
```
