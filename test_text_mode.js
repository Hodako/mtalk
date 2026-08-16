import { io } from 'socket.io-client';

async function runTextModeTest() {
  console.log('--- Testing Text Chat Mode E2E ---');
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
          topics: ['casual']
        });
      });
      client.on('session-ready', (data) => {
        console.log(`${name} session ready:`, data.sessionToken);
        resolve(data.sessionToken);
      });
    });
  };

  await Promise.all([
    initClient(clientA, 'Text_Alice', '🐱'),
    initClient(clientB, 'Text_Bob', '🦁')
  ]);

  console.log('Both text clients initialized. Joining text queue...');

  const matchPromise = new Promise((resolve) => {
    let matchCount = 0;
    clientA.on('match-found', (data) => {
      console.log('✅ Client A matched in text mode! Room:', data.roomId, 'Partner:', data.partner.nickname);
      matchCount++;
      if (matchCount === 2) resolve();
    });
    clientB.on('match-found', (data) => {
      console.log('✅ Client B matched in text mode! Room:', data.roomId, 'Partner:', data.partner.nickname);
      matchCount++;
      if (matchCount === 2) resolve();
    });
  });

  clientA.emit('join-queue', { mode: 'text', country: 'US', topics: ['casual'] });
  setTimeout(() => {
    clientB.emit('join-queue', { mode: 'text', country: 'US', topics: ['casual'] });
  }, 100);

  await matchPromise;

  // Test messaging
  const msgPromise = new Promise((resolve) => {
    clientB.on('new-message', (msg) => {
      console.log('✅ Client B received text message:', msg.text);
      if (msg.text === 'Hello Bob from text chat!') resolve();
    });
  });

  clientA.emit('send-message', { text: 'Hello Bob from text chat!' });
  await msgPromise;

  console.log('✅ Text Chat Mode E2E Test Passed Successfully!');
  clientA.disconnect();
  clientB.disconnect();
  process.exit(0);
}

runTextModeTest().catch(err => {
  console.error(err);
  process.exit(1);
});
