import { io } from 'socket.io-client';

async function testFlow() {
  console.log('--- Starting MTalk WebRTC Matchmaking E2E Test ---');

  const serverUrl = 'http://localhost:3000';

  const clientA = io(serverUrl, { forceNew: true });
  const clientB = io(serverUrl, { forceNew: true });

  const initClient = (client, name, avatar) => {
    return new Promise((resolve) => {
      client.on('connect', () => {
        console.log(`${name} connected with socket ID:`, client.id);
        client.emit('init-session', {
          nickname: name,
          avatar: avatar,
          country: 'US',
          topics: ['casual', 'gaming']
        });
      });
      client.on('session-ready', (data) => {
        console.log(`${name} session ready:`, data.sessionToken);
        resolve(data.sessionToken);
      });
    });
  };

  const [sessionA, sessionB] = await Promise.all([
    initClient(clientA, 'Alice_Tester', '🦊'),
    initClient(clientB, 'Bob_Tester', '🐼')
  ]);

  console.log('Both clients initialized. Joining voice queue...');

  const matchPromise = new Promise((resolve) => {
    let matchCount = 0;
    clientA.on('match-found', (data) => {
      console.log('✅ Client A matched! Room:', data.roomId, 'Partner:', data.partner.nickname);
      matchCount++;
      if (matchCount === 2) resolve();
    });
    clientB.on('match-found', (data) => {
      console.log('✅ Client B matched! Room:', data.roomId, 'Partner:', data.partner.nickname);
      matchCount++;
      if (matchCount === 2) resolve();
    });
  });

  clientA.emit('join-queue', { mode: 'voice', country: 'US', topics: ['casual'] });
  setTimeout(() => {
    clientB.emit('join-queue', { mode: 'voice', country: 'US', topics: ['casual'] });
  }, 100);

  await matchPromise;

  console.log('--- Testing WebRTC Signaling ---');
  const signalingPromise = new Promise((resolve) => {
    clientB.on('signal-offer', (data) => {
      console.log('✅ Client B received WebRTC Offer');
      clientB.emit('signal-answer', { answer: { type: 'answer', sdp: 'dummy_sdp_answer' } });
    });

    clientA.on('signal-answer', (data) => {
      console.log('✅ Client A received WebRTC Answer');
      resolve();
    });

    clientA.emit('signal-offer', { offer: { type: 'offer', sdp: 'dummy_sdp_offer' } });
  });

  await signalingPromise;

  console.log('--- Testing In-Call Text Chat ---');
  const chatPromise = new Promise((resolve) => {
    clientB.on('new-message', (msg) => {
      if (msg.senderId === clientA.id) {
        console.log('✅ Client B received chat message:', msg.text);
        resolve();
      }
    });
    clientA.emit('send-message', { text: 'Hello Bob! MTalk WebRTC is working!' });
  });

  await chatPromise;

  console.log('--- Testing In-Call Tic-Tac-Toe Game Move ---');
  const gamePromise = new Promise((resolve) => {
    clientB.on('game-move-received', (data) => {
      console.log('✅ Client B received game move:', data.index);
      resolve();
    });
    clientA.emit('game-move', {
      gameType: 'tictactoe',
      index: 4,
      symbol: 'X',
      board: [null, null, null, null, 'X', null, null, null, null],
      winner: null,
      isDraw: false
    });
  });

  await gamePromise;

  console.log('--- Testing Skip / Next Partner ---');
  const skipPromise = new Promise((resolve) => {
    clientB.on('partner-disconnected', (data) => {
      console.log('✅ Client B informed of partner disconnect (reason:', data.reason, ')');
      resolve();
    });
    clientA.emit('next-partner', { mode: 'voice' });
  });

  await skipPromise;

  console.log('--- All E2E Tests Passed Successfully! ---');
  clientA.disconnect();
  clientB.disconnect();
  process.exit(0);
}

testFlow().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
