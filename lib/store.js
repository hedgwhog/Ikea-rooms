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

// Upstash answers HGETALL as a flat list ([field1, value1, field2, value2, ...]) when
// automaticDeserialization is off. Turn that into { field1: value1, ... }.
function pairs(answer) {
  if (!answer) return {};
  if (!Array.isArray(answer)) return answer;
  const result = {};
  for (let i = 0; i < answer.length; i += 2) result[answer[i]] = answer[i + 1];
  return result;
}

// All three offer the same functions. Values are always JSON strings.
function upstash() {
  const r = new Upstash({ url: env[restUrl], token: env[restToken], automaticDeserialization: false });
  return {
    get: (k) => r.get(k),
    set: (k, v) => r.set(k, v, { ex: TTL }),
    del: (k) => r.del(k),
    // one HTTP request instead of two (a pipeline sends both commands together)
    hset: (k, f, v) => r.pipeline().hset(k, { [f]: v }).expire(k, TTL).exec(),
    hgetall: async (k) => pairs(await r.hgetall(k)),
    // HSETNX = "only set it if nobody did yet". Returns true if WE set it.
    hsetnx: async (k, fields) => {
      if (!fields.length) return [];
      const p = r.pipeline();
      for (const [f, v] of fields) p.hsetnx(k, f, v);
      p.expire(k, TTL);
      const answers = await p.exec();
      return answers.slice(0, fields.length).map((a) => Number(a) === 1);
    },
    keys: (p) => r.keys(p),
  };
}
function redis() {
  const c = () => (globalThis.__redis ??= createClient({ url: env[redisUrl] }).connect());
  return {
    get: async (k) => (await c()).get(k),
    set: async (k, v) => (await c()).set(k, v, { EX: TTL }),
    del: async (k) => (await c()).del(k),
    hset: async (k, f, v) => (await c()).multi().hSet(k, f, v).expire(k, TTL).exec(),
    hgetall: async (k) => pairs(await (await c()).hGetAll(k)),
    hsetnx: async (k, fields) => {
      if (!fields.length) return [];
      const m = (await c()).multi();
      for (const [f, v] of fields) m.hSetNX(k, f, v);
      m.expire(k, TTL);
      const answers = await m.exec();
      return answers.slice(0, fields.length).map((a) => a === true || Number(a) === 1);
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
    hsetnx: async (k, fields) => {
      const hash = (m.get(k) ?? {});
      const answers = fields.map(([f, v]) => (f in hash ? false : ((hash[f] = v), true)));
      m.set(k, hash);
      return answers;
    },
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

// Claims: who caught which item first. HSETNX makes sure only the FIRST claim counts,
// even when two players' requests arrive at the same moment. -> { itemId: playerId }
export const claim = (key, playerId, ids) => db.hsetnx(`claims:${key}`, ids.map((id) => [String(id), playerId]));
export const getClaims = (key) => db.hgetall(`claims:${key}`);

export const storageReport = () => ({
  storage: storageName,
  ready: storageReady,
  vercelEnvironment: env.VERCEL_ENV ?? null,
  databaseVariablesFound: Object.keys(env).filter((k) => /REDIS|KV_|UPSTASH/.test(k)),
});
