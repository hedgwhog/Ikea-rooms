// Everyone plays on the SAME field. The meatballs come from a seed, so every browser
// sees the same meatballs without the server sending them. Each player sends their bowl
// position ("live" data). Catches are CLAIMS: the server keeps who caught a ball first
// (lib/store.js -> claim), so a meatball can only be caught once. Steal them!
import { seeded } from "./util.js";

export const FIELD = { W: 1600, H: 900, BOWL: 110, BALL: 36 };
export const BOWL_Y = FIELD.H - 110; // where the bowls are (same for everyone)
const READY = 3000;
const PLAY = 30000;
const COUNT = 110;

export function makeBalls(seed) {
  const random = seeded(seed);
  return Array.from({ length: COUNT }, (_, i) => {
    const at = i * 0.27; // seconds after the start
    const speed = 230 + random() * 130 + i * 1.5; // later balls fall faster
    return {
      id: i,
      at,
      x: 40 + random() * (FIELD.W - 80),
      speed,
      gold: random() < 0.07,
      reachesBowl: at + BOWL_Y / speed, // seconds after the start when it reaches the bowls
    };
  });
}
export const scoreOf = (balls, caught = []) => caught.reduce((sum, id) => sum + (balls[id]?.gold ? 5 : balls[id] ? 1 : 0), 0);

// claims { ballId: playerId } -> { playerId: [ballIds] }
export function caughtBy(claims = {}) {
  const result = {};
  for (const [ball, player] of Object.entries(claims)) (result[player] ??= []).push(Number(ball));
  return result;
}

// Which of these claimed ball ids are believable right now? (no claiming balls that are
// still high up in the sky, or that don't exist). Generous, because clocks are never perfect.
export function validClaims(game, ids, now) {
  if (!Array.isArray(ids) || now > game.endsAt + 1000) return [];
  const time = (now - game.startAt) / 1000;
  const balls = makeBalls(game.seed);
  return [...new Set(ids)]
    .filter((id) => Number.isInteger(id) && balls[id])
    .filter((id) => time > balls[id].reachesBowl - 1.5)
    .slice(0, 10);
}

export const catchGame = {
  init: (players, now) => ({
    type: "catch",
    playerIds: players.map((p) => p.id),
    seed: Math.floor(Math.random() * 1e9),
    startAt: now + READY,
    endsAt: now + READY + PLAY,
    scores: {},
  }),
  tick(game, now, live, claims) {
    if (now < game.endsAt + 1000) return false; // 1s extra for the last catches to arrive
    const balls = makeBalls(game.seed);
    const caught = caughtBy(claims);
    for (const id of game.playerIds) game.scores[id] = scoreOf(balls, caught[id]);
    return (game.done = true);
  },
  score: (game, id) => game.scores[id] ?? 0, // meatball points
};
