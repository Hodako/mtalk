import { io } from 'socket.io-client';

async function testConsecutiveMatches() {
  console.log('--- Testing Multiple Consecutive Matches for Small User Pools ---');
  const serverUrl = 'http://localhost:3000';

  const clientA = io(serverUrl, { forceNew: true });
  const clientB = io(serverUrl, { forceNew: true });

  const initClient = (client, name) => {
    return new Promise((resolve) => {
      client.on('connect', () => {
        client.emit('init-session', { nickname: name, topics: ['casual'] });
      });
      client.on('session-ready', (data) => resolve(data.sessionToken));
    });
  };

  await Promise.all([initClient(clientA, 'UserA'), initClient(clientB, 'UserB')]);

  for (let matchRound = 1; matchRound <= 3; matchRound++) {
    console.log(`\nStarting Match Round ${matchRound}...`);
    const matchPromise = new Promise((resolve) => {
      let matched = 0;
      const onMatch = (client, name) => (data) => {
        matched++;
        console.log(`[Round ${matchRound}] ${name} matched with ${data.partner.nickname} in room ${data.roomId}`);
        if (matched === 2) {
          clientA.off('match-found');
          clientB.off('match-found');
          resolve();
        }
      };
      clientA.on('match-found', onMatch(clientA, 'UserA'));
      clientB.on('match-found', onMatch(clientB, 'UserB'));
    });

    clientA.emit('join-queue', { mode: 'voice' });
    setTimeout(() => clientB.emit('join-queue', { mode: 'voice' }), 100);

    await matchPromise;

    if (matchRound < 3) {
      console.log(`[Round ${matchRound}] UserA skipping partner to trigger next match...`);
      clientA.emit('next-partner', { mode: 'voice' });
      await new Promise(r => setTimeout(r, 400));
    }
  }

  console.log('\n✅ All 3 consecutive match rounds completed seamlessly in small pool!');
  clientA.disconnect();
  clientB.disconnect();
  process.exit(0);
}

testConsecutiveMatches().catch(e => {
  console.error('Test Failed:', e);
  process.exit(1);
});
