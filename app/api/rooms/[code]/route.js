// SERVER API (Route Handler)
//   GET  /api/rooms/ABCD -> how does the room look now? (browsers ask this every second)
//   POST /api/rooms/ABCD -> "I did something" { playerId, type, ... }
import { USES_CLAIMS, USES_LIVE } from "@/lib/games";
import { validClaims } from "@/lib/games/catch";
import { getExtras } from "@/lib/extras";
import { applyAction, dropIdle, isAbandoned, publicRoom, tickRoom } from "@/lib/room";
import { claim, deleteRoom, getClaims, getLive, getRoom, saveRoom, setLive, STORAGE_ERROR, storageReady } from "@/lib/store";

export const dynamic = "force-dynamic";
const json = (data, status = 200) => Response.json(data, { status });
const NO_EXTRAS = { products: undefined, rates: undefined };

async function handle(code, body) {
  if (!storageReady) return json({ error: STORAGE_ERROR }, 503);
  const isLive = body?.type === "live";
  // A game can start from "ready", "leave" or someone going idle, so have the products ready.
  // Loaded BEFORE the room, so nothing changes the room in between.
  // Live data is only sent DURING a game, and a game can't start during a game, so live
  // requests (many per second) skip this. That keeps them fast.
  const extras = isLive ? NO_EXTRAS : await getExtras();

  const room = await getRoom(code.toUpperCase());
  if (!room) return json({ error: "This room doesn't exist anymore." }, 404);
  const now = Date.now();
  const liveKey = `${room.code}:${room.gameIndex}`;
  const playing = room.phase === "playing";
  const usesClaims = playing && USES_CLAIMS.has(room.game.type);
  // A late live message after the game ended: just answer, the normal requests do the rest.
  if (isLive && !playing) return json(publicRoom(room, Date.now(), {}));

  // Live data (positions, catches) goes in its own place, so it never overwrites the room
  if (isLive) {
    const { claim: wanted, ...live } = body.live ?? {};
    const mayClaim = usesClaims && room.game.playerIds?.includes(body.playerId);
    await Promise.all([
      setLive(liveKey, body.playerId, { ...live, at: now }),
      mayClaim && claim(liveKey, body.playerId, validClaims(room.game, wanted, now)),
    ]);
  }
  const [live, claims] = await Promise.all([
    playing && USES_LIVE.has(room.game.type) ? getLive(liveKey) : {},
    usesClaims ? getClaims(liveKey) : undefined,
  ]);

  const idleRemoved = dropIdle(room, now, extras);
  let changed = tickRoom(room, now, live, claims) || idleRemoved;
  if (isAbandoned(room, now)) {
    await deleteRoom(room.code);
    return json({ error: "This room closed because everyone left." }, 404);
  }
  if (body && !isLive) {
    if (room.players[body.playerId]) room.players[body.playerId].seenAt = now; // a real action = still here
    const error = applyAction(room, body.playerId, body, now, extras);
    if (error) return json({ error }, 400);
    tickRoom(room, now, live, claims);
    changed = true;
  }
  if (changed) await saveRoom(room);
  return json(publicRoom(room, Date.now(), live, claims));
}

export async function GET(request, { params }) {
  const { code } = await params;
  try {
    return await handle(code, null);
  } catch (e) {
    console.error("Room error:", e); // the full error, in the terminal
    return json({ error: `Server error: ${e.message}` }, 500);
  }
}

export async function POST(request, { params }) {
  const { code } = await params;
  const body = await request.json().catch(() => null);
  if (!body?.playerId) return json({ error: "Bad request" }, 400);
  try {
    return await handle(code, body);
  } catch (e) {
    console.error("Room error:", e);
    return json({ error: `Server error: ${e.message}` }, 500);
  }
}
