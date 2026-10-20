import { CHARACTERS, GAMES, MAX_PLAYERS } from "./constants.js";
import { ENGINES } from "./games/index.js";

export const makeCode = () => Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]).join(""); // Randomize random 4 letter combination for room
export const newRoom = (code) => ({ code, createdAt: Date.now(), players: {}, scores: {}, phase: "lobby", gameIndex: -1, game: null, results: null });

export const IDLE_MS = 120_000; // Users can be idle for max 2 minutes
export const REMOVE_MS = 520_000; // idle users will be perma removed after 7 minutes

export function dropIdle(room, now, extras) {
  let changed = false;
  for (const p of players(room)) {
    if (!p.idle && now - (p.seenAt ?? 0) > IDLE_MS) {
      Object.assign(p, { idle: true, idleSince: now, ready: false });
      changed = true;
    } else if (p.idle && now - p.idleSince > REMOVE_MS) {
      applyAction(room, p.id, { type: "leave" }, now, extras);
      changed = true;
    }
  }
  if (changed) checkReady(room, now, extras);
  return changed;
}

// Delete the room when:
// - no players are left.
// - everyone is idle, and the last one went idle more than 1 minute ago.
export const ALL_IDLE_MS = 60_000;
export function isAbandoned(room, now) {
  const list = Object.values(room.players);
  if (list.length === 0) return now - (room.createdAt ?? 0) > 30_000;
  if (!list.every((p) => p.idle)) return false;
  const lastWentIdle = Math.max(...list.map((p) => p.idleSince));
  return now - lastWentIdle > ALL_IDLE_MS;
}
export const isFull = (room) => Object.keys(room.players).length >= MAX_PLAYERS;
const players = (room) => Object.values(room.players);
const engine = (room) => ENGINES[room.game.type];

function startGame(room, index, now, extras) {
  if (index >= GAMES.length) return (room.phase = "final");
  room.gameIndex = index;
  room.phase = "playing";
  room.game = ENGINES[GAMES[index].id].init(players(room), now, extras);
}

// After a game every player gets points: (number of players) - (players who did strictly better).
// So with 3 players: winner 3, second 2, last 1. A tie gets the same points:
//   A and B tie for first -> both 3, C gets 1.     B and C tie for second -> A 3, B and C both 2.
// Each game only says how well everyone did with score(game, id): higher = better.
function finishGame(room) {
  const game = room.game;
  const ids = (game.playerIds ?? Object.keys(room.players)).filter((id) => room.players[id]);
  const scoreOf = (id) => {
    try {
      const s = Number(engine(room).score(game, id));
      return Number.isFinite(s) ? s : 0;
    } catch (e) {
      console.error(`score() failed in ${game.type}:`, e); // never let a bug lock the room
      return 0;
    }
  };
  const ranked = ids.map((id) => ({ id, s: scoreOf(id) })).sort((a, b) => b.s - a.s);
  room.results = ranked.map(({ id, s }) => ({ id, points: ranked.length - ranked.filter((o) => o.s > s).length }));
  for (const { id, points } of room.results) room.scores[id] = (room.scores[id] ?? 0) + points;
  room.phase = "results";
}

// Ready up
const canReady = (room) => room.phase === "lobby" || room.phase === "results";

function checkReady(room, now, extras) {
  if (!canReady(room)) return;
  const active = players(room).filter((p) => !p.idle);
  if (active.length === 0 || !active.every((p) => p.ready)) return;
  players(room).forEach((p) => (p.ready = false));
  startGame(room, room.phase === "lobby" ? 0 : room.gameIndex + 1, now, extras);
}

// New user taking over an idle character
function renameId(value, oldId, newId) {
  if (value === oldId) return newId;
  if (Array.isArray(value)) return value.map((v) => renameId(v, oldId, newId));
  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k === oldId ? newId : k, renameId(v, oldId, newId)]));
  }
  return value;
}

// The new user gets the character that has been idle the longest, with its score and its spot in the game.
function takeOver(room, newId, now) {
  const idle = players(room)
    .filter((p) => p.idle)
    .sort((a, b) => a.idleSince - b.idleSince)[0];
  if (!idle) return false;

  for (const key of ["players", "scores", "game", "results"]) room[key] = renameId(room[key], idle.id, newId);

  const me = room.players[newId];
  Object.assign(me, { idle: false, ready: false, seenAt: now });
  delete me.idleSince;
  return true;
}

// When no one presses, time still continues.
export function tickRoom(room, now, live = {}, claims = {}) {
  if (room.phase !== "playing") return false;
  const changed = engine(room).tick(room.game, now, live, claims);
  if (room.game.done) finishGame(room);
  return changed;
}

// A player did something. Returns an error text, or nothing when it worked.
export function applyAction(room, id, action, now, extras) {
  const me = room.players[id];

  // Any action from the player counts as activity and makes them active again.
  if (me && action.type !== "leave") {
    me.seenAt = now;
    if (me.idle) {
      me.idle = false;
      delete me.idleSince;
    }
  }

  switch (action.type) {
    case "join": {
      if (me) return;
      if (takeOver(room, id, now)) return;
      if (isFull(room)) return "This room is full. All furniture is taken.";
      const free = CHARACTERS.find((c) => !players(room).some((p) => p.character === c.id));
      room.players[id] = { id, character: free.id, name: free.name, seenAt: now, ready: false };
      room.scores[id] = 0;
      return;
    }
    case "test": // DEV ONLY: jump straight to one minigame (buttons in the Lobby)
      if (process.env.NODE_ENV === "production") return "Not available";
      startGame(room, GAMES.findIndex((g) => g.id === action.game), now, extras);
      return;
      
    case "pick": {
      const c = CHARACTERS.find((c) => c.id === action.character);
      if (!me || !c || room.phase !== "lobby") return;
      if (players(room).some((p) => p.character === c.id && p.id !== id)) return `${c.name} is already taken`;
      Object.assign(me, { character: c.id, name: c.name }); // your name IS your furniture
      return;
    }
    case "leave": {
      delete room.players[id];
      delete room.scores[id];
      if (room.game?.playerIds) {
        for (const key of ["playerIds", "alive"]) if (room.game[key]) room.game[key] = room.game[key].filter((p) => p !== id);
      }
      checkReady(room, now, extras); 
      return;
    }
    case "ping":
      return;
    case "ready": {
      // { type: "ready" } toggles, { type: "ready", ready: true/false } sets it
      if (!me || !canReady(room)) return;
      me.ready = action.ready ?? !me.ready;
      checkReady(room, now, extras);
      return;
    }
    case "restart":
      if (room.phase === "final") {
        Object.keys(room.scores).forEach((p) => (room.scores[p] = 0));
        players(room).forEach((p) => (p.ready = false));
        Object.assign(room, { phase: "lobby", gameIndex: -1, game: null, results: null });
      }
      return;
    case "game":
      if (room.phase === "playing" && me) engine(room).act?.(room.game, id, action, now);
      return;
    default:
      return "Unknown action";
  }
}

// Hides secret stuff from users in the browser.
export function publicRoom(room, now, live, claims) {
  const game = room.game && { ...room.game, live, claims };
  if (game && !game.done) delete game.secret;
  return { room: { ...room, game }, serverNow: now };
}

