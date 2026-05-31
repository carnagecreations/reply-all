// REPLY ALL — Game State Machine
import { getRandomPremise, getRandomConstraint } from './content.js';

export const PHASES = {
  LOBBY: 'LOBBY',
  PREMISE: 'PREMISE',
  WRITING: 'WRITING',
  REVEAL: 'REVEAL',
  VOTING: 'VOTING',
  SCORES: 'SCORES',
  GAME_OVER: 'GAME_OVER',
};

const AVATAR_COLORS = [
  '#C0392B', '#E67E22', '#F1C40F', '#27AE60', '#2980B9',
  '#8E44AD', '#16A085', '#D35400', '#2C3E50', '#7F8C8D',
];

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function generateSubjectLine(roundNum, premise) {
  const base = premise.split('.')[0].trim().substring(0, 40);
  const rePrefix = 'RE: '.repeat(Math.min(roundNum, 3));
  return rePrefix + base;
}

export class Room {
  constructor(code, settings = {}) {
    this.code = code;
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this.hostId = null;

    this.settings = {
      totalRounds: settings.totalRounds ?? 3,
      writingTime: settings.writingTime ?? 90,
      votingTime: settings.votingTime ?? 30,
      constraintsEnabled: settings.constraintsEnabled ?? true,
      hostPlays: settings.hostPlays ?? true,
    };

    this.currentRound = 0;
    this.roundScores = {};
    this.rounds = [];

    this.premise = null;
    this.subjectLine = null;
    this.submissions = new Map();
    this.votes = new Map();
    this.revealIndex = 0;
    this.revealOrder = [];

    this.timer = null;
    this.timerEnd = null;
    this.disconnectTimers = new Map();

    this.createdAt = Date.now();
    this.lastActivity = Date.now();
  }

  addPlayer(id, name, isHost = false) {
    const usedColors = new Set([...this.players.values()].map(p => p.color));
    const color = AVATAR_COLORS.find(c => !usedColors.has(c)) || AVATAR_COLORS[0];

    const player = {
      id,
      name: name.trim().substring(0, 20),
      color,
      score: 0,
      connected: true,
      isHost,
      submittedThisRound: false,
      votedThisRound: false,
      joinedMidGame: false,
    };

    this.players.set(id, player);
    if (isHost || this.players.size === 1) this.hostId = id;
    this.roundScores[id] = 0;
    this.lastActivity = Date.now();
    return player;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = false;
    this.lastActivity = Date.now();
  }

  kickPlayer(id) {
    this.players.delete(id);
    delete this.roundScores[id];
    this.lastActivity = Date.now();
  }

  reconnectPlayer(oldId, newId) {
    const player = this.players.get(oldId);
    if (!player) return null;
    this.players.delete(oldId);
    player.id = newId;
    player.connected = true;
    this.players.set(newId, player);
    if (this.hostId === oldId) this.hostId = newId;
    return player;
  }

  getConnectedPlayers() {
    return [...this.players.values()].filter(p => p.connected);
  }

  getAllPlayers() {
    return [...this.players.values()];
  }

  getWriters() {
    if (this.settings.hostPlays) {
      return this.getConnectedPlayers();
    }
    return this.getConnectedPlayers().filter(p => p.id !== this.hostId);
  }

  startGame() {
    this.currentRound = 0;
    this.getAllPlayers().forEach(p => { p.score = 0; });
    this.startRound();
  }

  startRound() {
    this.currentRound++;
    this.phase = PHASES.PREMISE;
    this.premise = getRandomPremise();
    this.subjectLine = generateSubjectLine(this.currentRound, this.premise);
    this.submissions = new Map();
    this.votes = new Map();
    this.revealIndex = 0;
    this.revealOrder = [];
    this.getAllPlayers().forEach(p => {
      p.submittedThisRound = false;
      p.votedThisRound = false;
    });

    this.playerConstraints = new Map();
    if (this.settings.constraintsEnabled) {
      this.getWriters().forEach(p => {
        const isHost = p.id === this.hostId;
        if (isHost || Math.random() < 0.85) {
          this.playerConstraints.set(p.id, getRandomConstraint());
        }
      });
    }

    this.lastActivity = Date.now();
  }

  startWriting() {
    this.phase = PHASES.WRITING;
    this.timerEnd = Date.now() + this.settings.writingTime * 1000;
    this.lastActivity = Date.now();
  }

  submitReply(playerId, text) {
    if (this.phase !== PHASES.WRITING) return false;
    if (this.submissions.has(playerId)) return false;
    const player = this.players.get(playerId);
    if (!player) return false;
    if (player.joinedMidGame) return false;

    this.submissions.set(playerId, {
      playerId,
      playerName: player.name,
      text: text.trim().substring(0, 800),
      constraint: this.playerConstraints?.get(playerId) || null,
    });
    player.submittedThisRound = true;
    this.lastActivity = Date.now();
    return true;
  }

  allSubmitted() {
    const writers = this.getWriters().filter(p => p.connected);
    return writers.length > 0 && writers.every(p => p.submittedThisRound);
  }

  startReveal() {
    this.phase = PHASES.REVEAL;
    const ids = [...this.submissions.keys()];
    this.revealOrder = ids.sort(() => Math.random() - 0.5);
    this.revealIndex = 0;
    this.lastActivity = Date.now();
  }

  nextReveal() {
    this.revealIndex++;
    return this.revealIndex <= this.revealOrder.length;
  }

  getRevealedReplies() {
    return this.revealOrder.slice(0, this.revealIndex).map(id => this.submissions.get(id));
  }

  startVoting() {
    this.phase = PHASES.VOTING;
    this.timerEnd = Date.now() + this.settings.votingTime * 1000;
    this.lastActivity = Date.now();
  }

  submitVote(voterId, targetId) {
    if (this.phase !== PHASES.VOTING) return false;
    if (voterId === targetId) return false;
    if (this.votes.has(voterId)) return false;
    if (!this.submissions.has(targetId)) return false;

    this.votes.set(voterId, targetId);
    const voter = this.players.get(voterId);
    if (voter) voter.votedThisRound = true;
    this.lastActivity = Date.now();
    return true;
  }

  allVoted() {
    const eligible = this.getConnectedPlayers().filter(p => {
      if (!this.settings.hostPlays && p.id === this.hostId) return false;
      return true;
    });
    return eligible.length > 0 && eligible.every(p => p.votedThisRound);
  }

  tallyVotes() {
    const tally = {};
    [...this.submissions.keys()].forEach(id => { tally[id] = 0; });
    this.votes.forEach((targetId) => { tally[targetId] = (tally[targetId] || 0) + 1; });

    let maxVotes = 0;
    Object.values(tally).forEach(v => { if (v > maxVotes) maxVotes = v; });

    const roundResults = {};
    [...this.submissions.entries()].forEach(([pid, sub]) => {
      const votes = tally[pid] || 0;
      const isWinner = votes === maxVotes && votes > 0;
      const pts = votes * 100 + (isWinner ? 50 : 0);
      const prevScore = this.players.get(pid)?.score || 0;
      roundResults[pid] = {
        votes,
        points: pts,
        isWinner,
        submission: sub,
        scoreBeforeRound: prevScore,
      };
      const player = this.players.get(pid);
      if (player) player.score += pts;
    });

    this.currentRoundResults = roundResults;
    this.phase = PHASES.SCORES;
    this.lastActivity = Date.now();
    return roundResults;
  }

  isGameOver() {
    return this.currentRound >= this.settings.totalRounds;
  }

  getScoreboard() {
    return this.getAllPlayers()
      .sort((a, b) => b.score - a.score)
      .map((p, i) => ({ ...p, rank: i + 1 }));
  }

  getPublicState() {
    const players = this.getAllPlayers().map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      score: p.score,
      connected: p.connected,
      isHost: p.id === this.hostId,
      submittedThisRound: p.submittedThisRound,
      votedThisRound: p.votedThisRound,
      joinedMidGame: p.joinedMidGame,
    }));

    const base = {
      code: this.code,
      phase: this.phase,
      players,
      currentRound: this.currentRound,
      totalRounds: this.settings.totalRounds,
      settings: this.settings,
    };

    if (this.phase === PHASES.PREMISE || this.phase === PHASES.WRITING) {
      base.premise = this.premise;
      base.subjectLine = this.subjectLine;
      base.timerEnd = this.timerEnd;
    }

    if (this.phase === PHASES.REVEAL) {
      base.premise = this.premise;
      base.subjectLine = this.subjectLine;
      base.revealedReplies = this.getRevealedReplies();
      base.totalReplies = this.submissions.size;
      base.revealIndex = this.revealIndex;
    }

    if (this.phase === PHASES.VOTING) {
      base.premise = this.premise;
      base.subjectLine = this.subjectLine;
      base.timerEnd = this.timerEnd;
      const allReplies = [...this.submissions.entries()].map(([pid, sub]) => ({
        id: pid,
        text: sub.text,
      })).sort(() => Math.random() - 0.5);
      base.votingReplies = allReplies;
    }

    if (this.phase === PHASES.SCORES || this.phase === PHASES.GAME_OVER) {
      base.premise = this.premise;
      base.subjectLine = this.subjectLine;
      base.roundResults = this.currentRoundResults;
      base.scoreboard = this.getScoreboard();
      base.revealedReplies = this.getRevealedReplies();
    }

    return base;
  }

  getPlayerPrivateState(playerId) {
    return {
      constraint: this.playerConstraints?.get(playerId) || null,
      mySubmission: this.submissions.get(playerId) || null,
      myVote: this.votes.get(playerId) || null,
      isWriter: this.getWriters().some(p => p.id === playerId),
    };
  }
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
    setInterval(() => this.cleanup(), 30 * 60 * 1000);
  }

  createRoom(settings) {
    let code;
    do { code = generateRoomCode(); } while (this.rooms.has(code));
    const room = new Room(code, settings);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(code?.toUpperCase());
  }

  deleteRoom(code) {
    this.rooms.delete(code);
  }

  cleanup() {
    const now = Date.now();
    this.rooms.forEach((room, code) => {
      const age = now - room.lastActivity;
      if (age > 2 * 60 * 60 * 1000) {
        this.rooms.delete(code);
      }
    });
  }
}