// Where rooms are saved in order:
//  1. Upstash Redis over REST (env vars ending in _REST_API_URL + _REST_API_TOKEN)
//  2. Any Redis URL           (REDIS_URL / KV_URL = "redis://..." or "rediss://...")
//  3. Server memory           (only when running on your own computer)
import { Redis as Upstash } from "@upstash/redis";
import { createClient } from "redis";

const env = process.env;
const TTL = 60 * 60; // rooms are forgotten after 1 hour, if no activity
const findEnv = (test) => Object.keys(env).find((k) => env[k] && test(k, env[k]));
const restUrl = findEnv((k, v) => /_REST(_API)?_URL$/.test(k) && v.startsWith("https://"));
const restToken = findEnv((k) => /_REST(_API)?_TOKEN$/.test(k) && !k.includes("READ_ONLY"));
const redisUrl = findEnv((k, v) => /(^|_)(REDIS_URL|KV_URL)$/.test(k) && /^rediss?:\/\//.test(v));
export const storageName = restUrl && restToken ? "upstash" : redisUrl ? "redis" : "memory";

// All three offer the same 6 functions. Values are always JSON strings.
function upstash() {
  const r = new Upstash({ url: env[restUrl], token: env[restToken], automaticDeserialization: false });
  return {
    get: (k) => r.get(k),
    set: (k, v) => r.set(k, v, { ex: TTL }),
    del: (k) => r.del(k),
    hset: async (k, f, v) => (await r.hset(k, { [f]: v }), r.expire(k, TTL)),
    hgetall: async (k) => (await r.hgetall(k)) ?? {},
    keys: (p) => r.keys(p),
  };
}
function redis() {
  const c = () => (globalThis.__redis ??= createClient({ url: env[redisUrl] }).connect());
  return {
    get: async (k) => (await c()).get(k),
    set: async (k, v) => (await c()).set(k, v, { EX: TTL }),
    del: async (k) => (await c()).del(k),
    hset: async (k, f, v) => (await (await c()).hSet(k, f, v), (await c()).expire(k, TTL)),
    hgetall: async (k) => {
      const answer = (await r.hgetall(k)) ?? {};
      if (!Array.isArray(answer)) return answer;
      // Upstash answers as a flat list: [player1, data1, player2, data2, ...] -> turn it into { player1: data1, ... }
      const result = {};
      for (let i = 0; i < answer.length; i += 2) result[answer[i]] = answer[i + 1];
      return result;
    },
    keys: async (p) => (await c()).keys(p),
  };
}
function memory() {
  const m = (globalThis.__memory ??= new Map());
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => m.set(k, v),
    del: async (k) => m.delete(k),
    hset: async (k, f, v) => m.set(k, { ...(m.get(k) ?? {}), [f]: v }),
    hgetall: async (k) => m.get(k) ?? {},
    keys: async (p) => [...m.keys()].filter((k) => k.startsWith(p.replace("*", ""))),
  };
}
const db = { upstash, redis, memory }[storageName]();

// Some Vercel preperations to make it work.
export const storageReady = storageName !== "memory" || !env.VERCEL;
export const STORAGE_ERROR = "No database connected. Open /api/health on this site to see what's missing.";

export async function getRoom(code) {
  const raw = await db.get(`room:${code}`);
  return raw ? JSON.parse(raw) : null;
}
export const saveRoom = (room) => db.set(`room:${room.code}`, JSON.stringify(room));
export const deleteRoom = (code) => db.del(`room:${code}`);
export async function listRooms() {
  const keys = await db.keys("room:*");
  return (await Promise.all(keys.map((k) => getRoom(k.slice(5))))).filter(Boolean);
}

export const setLive = (key, playerId, data) => db.hset(`live:${key}`, playerId, JSON.stringify(data));
export async function getLive(key) {
  const all = await db.hgetall(`live:${key}`);
  const live = {};
  for (const [id, value] of Object.entries(all)) {
    try {
      live[id] = typeof value === "string" ? JSON.parse(value) : value;
    } catch {
      // one broken value: skip it instead of crashing the room
    }
  }
  return live;
}

export const storageReport = () => ({
  storage: storageName,
  ready: storageReady,
  vercelEnvironment: env.VERCEL_ENV ?? null,
  databaseVariablesFound: Object.keys(env).filter((k) => /REDIS|KV_|UPSTASH/.test(k)),
});
