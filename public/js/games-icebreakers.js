/**
 * MTalk Interactive In-Call Mini-Games & Icebreakers
 */

const ICEBREAKER_QUESTIONS = [
  "If you could wake up tomorrow in any city in the world, where would you go?",
  "What is the most bizarre food you have ever tasted?",
  "If you could have any superpower for 24 hours, what would you choose?",
  "What is one movie or show you can re-watch 100 times without getting bored?",
  "If you won $10,000,000 today, what is the very first thing you would buy?",
  "What's your most controversial food opinion (e.g. pineapple on pizza)?",
  "If you could invite any 3 people in history to a dinner party, who would they be?",
  "What is a hobby or skill you’ve always wanted to master?",
  "Are you a night owl or an early bird, and why?",
  "What is the best concert or live event you have ever attended?",
  "If you were an animal, which one matches your personality best?",
  "What's the funniest or weirdest random encounter you've had with a stranger?",
  "Would you rather explore deep space or the deep ocean?",
  "What is a song that instantly puts you in a good mood?",
  "If you could speak any 3 languages fluently right now, which would you pick?",
  "What is something you believed as a kid that turned out to be completely false?",
  "Would you rather always be 15 minutes late or 20 minutes early?",
  "What is the most memorable road trip or vacation you've taken?",
  "If your life was a movie, what genre would it be?",
  "What is a trend or fashion you secretly loved or hated?"
];

class GameManager {
  constructor(socket, webrtcManager) {
    this.socket = socket;
    this.webrtc = webrtcManager;
    this.activeGame = null;
    this.isMyTurn = false;
    this.mySymbol = 'X';
    this.partnerSymbol = 'O';
    this.tttBoard = Array(9).fill(null);
    this.rpsMyChoice = null;
    this.rpsPartnerChoice = null;
    this.scores = { me: 0, partner: 0 };
    this.onStateUpdate = null;
  }

  // Icebreaker logic
  getRandomIcebreaker() {
    const idx = Math.floor(Math.random() * ICEBREAKER_QUESTIONS.length);
    return ICEBREAKER_QUESTIONS[idx];
  }

  shareIcebreaker(question) {
    if (this.socket) {
      this.socket.emit('icebreaker-draw', { question });
    }
  }

  // Mini-Games: Tic-Tac-Toe
  startTicTacToe(isInitiator) {
    this.activeGame = 'tictactoe';
    this.tttBoard = Array(9).fill(null);
    this.mySymbol = isInitiator ? 'X' : 'O';
    this.partnerSymbol = isInitiator ? 'O' : 'X';
    this.isMyTurn = isInitiator;

    if (this.onStateUpdate) {
      this.onStateUpdate({
        game: 'tictactoe',
        board: this.tttBoard,
        myTurn: this.isMyTurn,
        mySymbol: this.mySymbol,
        winner: null,
        isDraw: false
      });
    }
  }

  makeTicTacToeMove(index) {
    if (this.activeGame !== 'tictactoe' || !this.isMyTurn || this.tttBoard[index]) {
      return false;
    }

    this.tttBoard[index] = this.mySymbol;
    this.isMyTurn = false;

    const winner = this.checkTicTacToeWinner();
    const isDraw = !winner && this.tttBoard.every(cell => cell !== null);

    // Send move to partner
    const moveData = {
      gameType: 'tictactoe',
      index,
      symbol: this.mySymbol,
      board: this.tttBoard,
      winner,
      isDraw
    };

    if (this.socket) {
      this.socket.emit('game-move', moveData);
    }

    if (this.onStateUpdate) {
      this.onStateUpdate({
        game: 'tictactoe',
        board: this.tttBoard,
        myTurn: this.isMyTurn,
        mySymbol: this.mySymbol,
        winner,
        isDraw
      });
    }

    return true;
  }

  handleRemoteMove(data) {
    if (data.gameType === 'tictactoe') {
      this.tttBoard = data.board;
      this.isMyTurn = true;
      const winner = data.winner;
      const isDraw = data.isDraw;

      if (this.onStateUpdate) {
        this.onStateUpdate({
          game: 'tictactoe',
          board: this.tttBoard,
          myTurn: this.isMyTurn,
          mySymbol: this.mySymbol,
          winner,
          isDraw
        });
      }
    } else if (data.gameType === 'rps') {
      if (data.action === 'picked') {
        this.rpsPartnerChoice = 'ready';
        if (this.rpsMyChoice) {
          // Both have chosen, request reveal
          this.socket.emit('game-move', {
            gameType: 'rps',
            action: 'reveal',
            choice: this.rpsMyChoice
          });
        }
      } else if (data.action === 'reveal') {
        this.rpsPartnerChoice = data.choice;
        this.evaluateRPS();
      }
    }
  }

  checkTicTacToeWinner() {
    const lines = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8],
      [0, 3, 6], [1, 4, 7], [2, 5, 8],
      [0, 4, 8], [2, 4, 6]
    ];
    for (let i = 0; i < lines.length; i++) {
      const [a, b, c] = lines[i];
      if (this.tttBoard[a] && this.tttBoard[a] === this.tttBoard[b] && this.tttBoard[a] === this.tttBoard[c]) {
        return this.tttBoard[a];
      }
    }
    return null;
  }

  // Mini-Games: Rock-Paper-Scissors
  startRPS() {
    this.activeGame = 'rps';
    this.rpsMyChoice = null;
    this.rpsPartnerChoice = null;
    if (this.onStateUpdate) {
      this.onStateUpdate({
        game: 'rps',
        myChoice: null,
        partnerChoice: null,
        result: null,
        scores: this.scores
      });
    }
  }

  makeRPSChoice(choice) {
    if (this.activeGame !== 'rps') return;
    this.rpsMyChoice = choice;

    if (this.socket) {
      this.socket.emit('game-move', {
        gameType: 'rps',
        action: 'picked'
      });
    }

    if (this.rpsPartnerChoice === 'ready') {
      this.socket.emit('game-move', {
        gameType: 'rps',
        action: 'reveal',
        choice: this.rpsMyChoice
      });
    }

    if (this.onStateUpdate) {
      this.onStateUpdate({
        game: 'rps',
        myChoice: this.rpsMyChoice,
        partnerChoice: this.rpsPartnerChoice,
        result: null,
        scores: this.scores
      });
    }
  }

  evaluateRPS() {
    if (!this.rpsMyChoice || !this.rpsPartnerChoice || this.rpsPartnerChoice === 'ready') return;

    let result = 'draw';
    if (this.rpsMyChoice === this.rpsPartnerChoice) {
      result = 'draw';
    } else if (
      (this.rpsMyChoice === 'rock' && this.rpsPartnerChoice === 'scissors') ||
      (this.rpsMyChoice === 'paper' && this.rpsPartnerChoice === 'rock') ||
      (this.rpsMyChoice === 'scissors' && this.rpsPartnerChoice === 'paper')
    ) {
      result = 'win';
      this.scores.me++;
    } else {
      result = 'lose';
      this.scores.partner++;
    }

    if (this.onStateUpdate) {
      this.onStateUpdate({
        game: 'rps',
        myChoice: this.rpsMyChoice,
        partnerChoice: this.rpsPartnerChoice,
        result,
        scores: this.scores
      });
    }
  }

  reset() {
    this.activeGame = null;
    this.tttBoard = Array(9).fill(null);
    this.rpsMyChoice = null;
    this.rpsPartnerChoice = null;
  }
}

window.GameManager = GameManager;
