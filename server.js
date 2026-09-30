const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

const PROMPTS = [
  {
    real: "The smallest bone in the human body is the Stapes (in the ear). Write a believable fake anatomical fact or restate this clearly.",
    fake: "Write a plausible-sounding fact about human bones or anatomy."
  },
  {
    real: "Honey never spoils; 3,000-year-old edible honey was found in Egyptian tombs. Write a believable food shelf-life fact.",
    fake: "Write a believable fact about ancient Egyptian food or long-lasting food."
  },
  {
    real: "Venus is the hottest planet in our solar system at 867°F (464°C). Write a believable astronomy fact.",
    fake: "Write a plausible-sounding fact about space or the solar system."
  },
  {
    real: "Bananas are berries, but strawberries are not botanically berries. Write a believable botany fact.",
    fake: "Write a plausible-sounding fact about fruits or agriculture."
  },
  {
    real: "Octopuses have three hearts and blue blood. Write a believable marine biology fact.",
    fake: "Write a plausible-sounding fact about sea creatures."
  }
];

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ name }) => {
    let roomCode = generateRoomCode();
    while (rooms[roomCode]) {
      roomCode = generateRoomCode();
    }

    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      players: [{ id: socket.id, name, score: 0 }],
      state: 'LOBBY',
      round: 0,
      maxRounds: 3,
      currentPrompt: null,
      impostorId: null,
      submissions: {},
      votes: {},
      timer: null,
      timeLeft: 45
    };

    socket.join(roomCode);
    socket.emit('room_created', { roomCode, playerId: socket.id });
    io.to(roomCode).emit('room_update', getRoomState(roomCode));
  });

  socket.on('join_room', ({ name, roomCode }) => {
    const code = roomCode.toUpperCase().trim();
    const room = rooms[code];

    if (!room) {
      return socket.emit('error_message', 'Room not found.');
    }
    if (room.state !== 'LOBBY') {
      return socket.emit('error_message', 'Game already in progress.');
    }
    if (room.players.length >= 8) {
      return socket.emit('error_message', 'Room is full (max 8 players).');
    }

    room.players.push({ id: socket.id, name, score: 0 });
    socket.join(code);
    socket.emit('room_joined', { roomCode: code, playerId: socket.id });
    io.to(code).emit('room_update', getRoomState(code));
  });

  socket.on('start_game', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) {
      return socket.emit('error_message', 'Need at least 2 players to start.');
    }

    startRound(roomCode);
  });

  socket.on('submit_answer', ({ roomCode, answer }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'SUBMIT') return;

    room.submissions[socket.id] = answer.trim() || "...";
    io.to(roomCode).emit('submission_status', {
      submittedCount: Object.keys(room.submissions).length,
      totalPlayers: room.players.length
    });

    if (Object.keys(room.submissions).length === room.players.length) {
      clearInterval(room.timer);
      startVotingPhase(roomCode);
    }
  });

  socket.on('submit_vote', ({ roomCode, targetId }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'VOTE') return;
    if (targetId === socket.id) return;

    room.votes[socket.id] = targetId;
    io.to(roomCode).emit('vote_status', {
      votedCount: Object.keys(room.votes).length,
      totalPlayers: room.players.length
    });

    if (Object.keys(room.votes).length === room.players.length) {
      clearInterval(room.timer);
      calculateAndShowResults(roomCode);
    }
  });

  socket.on('next_round', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    if (room.round >= room.maxRounds) {
      room.state = 'GAMEOVER';
      io.to(roomCode).emit('game_over', { players: room.players });
    } else {
      startRound(roomCode);
    }
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        room.players.splice(index, 1);
        if (room.players.length === 0) {
          clearInterval(room.timer);
          delete rooms[code];
        } else {
          if (room.hostId === socket.id) {
            room.hostId = room.players[0].id;
          }
          io.to(code).emit('room_update', getRoomState(code));
        }
        break;
      }
    }
  });
});

function getRoomState(roomCode) {
  const room = rooms[roomCode];
  return {
    code: room.code,
    hostId: room.hostId,
    players: room.players,
    state: room.state,
    round: room.round,
    maxRounds: room.maxRounds
  };
}

function startRound(roomCode) {
  const room = rooms[roomCode];
  room.round += 1;
  room.state = 'SUBMIT';
  room.submissions = {};
  room.votes = {};
  
  const impostorIndex = Math.floor(Math.random() * room.players.length);
  room.impostorId = room.players[impostorIndex].id;

  const promptObj = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
  room.currentPrompt = promptObj;

  room.players.forEach(player => {
    const isImpostor = player.id === room.impostorId;
    io.to(player.id).emit('round_start', {
      round: room.round,
      maxRounds: room.maxRounds,
      isImpostor,
      prompt: isImpostor ? promptObj.fake : promptObj.real
    });
  });

  room.timeLeft = 45;
  clearInterval(room.timer);
  room.timer = setInterval(() => {
    room.timeLeft -= 1;
    io.to(roomCode).emit('timer_tick', { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      room.players.forEach(p => {
        if (!room.submissions[p.id]) room.submissions[p.id] = "(Timed out)";
      });
      startVotingPhase(roomCode);
    }
  }, 1000);
}

function startVotingPhase(roomCode) {
  const room = rooms[roomCode];
  room.state = 'VOTE';

  const submissionList = room.players.map(p => ({
    playerId: p.id,
    playerName: p.name,
    text: room.submissions[p.id] || "(No submission)"
  }));

  io.to(roomCode).emit('voting_start', { submissions: submissionList });

  room.timeLeft = 30;
  clearInterval(room.timer);
  room.timer = setInterval(() => {
    room.timeLeft -= 1;
    io.to(roomCode).emit('timer_tick', { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      calculateAndShowResults(roomCode);
    }
  }, 1000);
}

function calculateAndShowResults(roomCode) {
  const room = rooms[roomCode];
  room.state = 'RESULTS';

  const impostor = room.players.find(p => p.id === room.impostorId);
  const roundResults = [];

  room.players.forEach(p => {
    let pointsGained = 0;
    const votedForId = room.votes[p.id];

    if (p.id === room.impostorId) {
      room.players.forEach(other => {
        if (other.id !== room.impostorId && room.votes[other.id] !== room.impostorId) {
          pointsGained += 150;
        }
      });
    } else {
      if (votedForId === room.impostorId) {
        pointsGained += 100;
      }
    }

    p.score += pointsGained;
    roundResults.push({
      id: p.id,
      name: p.name,
      pointsGained,
      totalScore: p.score,
      votedFor: room.players.find(target => target.id === votedForId)?.name || "Nobody"
    });
  });

  io.to(roomCode).emit('round_results', {
    impostorName: impostor ? impostor.name : "Unknown",
    impostorId: room.impostorId,
    results: roundResults,
    round: room.round,
    maxRounds: room.maxRounds
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});