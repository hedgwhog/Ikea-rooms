"use client";
// Everyone's bowl is on the same field. Every browser builds the same meatballs from the seed.
//
// Smooth: the game loop (60x a second) does NOT re-render React. It draws the meatballs on a
// <canvas> and moves the bowls by changing their style directly. React only re-renders for
// the scores and the timer.
//
// Stealing: catching a ball sends a "claim" to the server. The server only accepts the FIRST
// claim for each ball, so a meatball can be caught once. If someone else was first, you lose it.
// When another bowl touches a ball it disappears right away (a guess that the server confirms).
import { useEffect, useMemo, useReducer, useRef } from "react";
import { useRoom } from "@/context/RoomContext";
import { useInterval } from "@/hooks/useInterval";
import { direction, useKeys } from "@/hooks/useKeys";
import { useTimeLeft } from "@/hooks/useTimeLeft";
import { BOWL_Y, caughtBy, FIELD, makeBalls, scoreOf } from "@/lib/games/catch";
import { useTheme } from "@/context/ThemeContext";
import Furniture from "../Furniture";

const { W, H, BOWL, BALL } = FIELD;
const pct = (n, of) => `${(n / of) * 100}%`;
const inBand = (y) => y > BOWL_Y - 10 && y < BOWL_Y + 20; // the height where bowls catch
const touches = (ball, x) => Math.abs(ball.x - x) < BOWL / 2 + 6;
const bowlTransform = (x) => `translateX(${((x - BOWL / 2) / BOWL) * 100}%)`; // % of the bowl's own width
const GIVE_UP_MS = 4000; // a claim the server never confirmed stops counting after this

export default function MeatballCatch() {
  const { me, room, now, sendLive } = useRoom();
  const { dark } = useTheme();
  const game = room.game;
  const live = game.live ?? {};
  const claims = game.claims ?? {};
  const keys = useKeys();
  const field = useRef(null);
  const canvas = useRef(null);
  const bowlEls = useRef({}); // player id -> bowl element
  const [, rerender] = useReducer((n) => n + 1, 0);
  useTimeLeft(game.endsAt); // re-renders 5x a second for the timer

  const balls = useMemo(() => makeBalls(game.seed), [game.seed]); // same balls for everyone

  // Everything the game loop changes. A ref, so changing it doesn't re-render.
  const s = useRef({
    x: W / 2,
    target: null,
    mine: new Set(), // balls I caught (confirmed, or still waiting for the server)
    pending: new Map(), // ball id -> when I claimed it
    guessed: new Set(), // balls I think another player caught (the server confirms later)
    shownX: {}, // where I DRAW the other bowls (glides toward their real position)
    pops: [], // floating "+1" / "Stolen" texts
  });
  // The newest server data, readable from inside the loop
  const server = useRef({ live, claims });
  server.current = { live, claims };
  const nameOf = useRef(null);
  nameOf.current = (id) => room.players[id]?.name ?? "Someone";

  // The server answered: which of my claims were confirmed, and which were stolen?
  useEffect(() => {
    const st = s.current;
    let changed = false;
    for (const [id, since] of st.pending) {
      const owner = claims[id];
      if (owner === me) st.pending.delete(id);
      else if (owner || Date.now() - since > GIVE_UP_MS) {
        st.pending.delete(id);
        st.mine.delete(id);
        const text = owner ? `${nameOf.current(owner)} was first!` : "Missed";
        st.pops.push({ x: st.x, y: BOWL_Y - 40, text, color: "#e0302e", t0: performance.now() });
        changed = true;
      }
    }
    if (changed) rerender();
  }, [claims, me]);

  // My position + the catches the server hasn't confirmed yet (sent again until it does)
  const send = () => sendLive({ x: Math.round(s.current.x), claim: [...s.current.pending.keys()] });
  useInterval(send, 100);
  const sendRef = useRef(send);
  sendRef.current = send;

  // Game loop
  useEffect(() => {
    const ctx = canvas.current.getContext("2d");
    let sprites = null;
    let last = performance.now();
    let frame;

    // Paint both kinds of meatball once at the right size; every frame just copies them.
    const makeSprites = (size) => {
      const make = (stops) => {
        const c = document.createElement("canvas");
        c.width = c.height = Math.max(1, Math.ceil(size));
        const g = c.getContext("2d");
        const r = size / 2;
        const grad = g.createRadialGradient(r * 0.7, r * 0.6, 0, r, r, r);
        stops.forEach(([at, color]) => grad.addColorStop(at, color));
        g.fillStyle = grad;
        g.beginPath();
        g.arc(r, r, r, 0, Math.PI * 2);
        g.fill();
        return c;
      };
      return {
        size,
        normal: make([[0, "#b97a4a"], [0.6, "#7a4524"], [1, "#5a3118"]]),
        gold: make([[0, "#fff6c2"], [0.45, "#ffcf2e"], [1, "#c98a00"]]),
      };
    };

    const loop = (t) => {
      frame = requestAnimationFrame(loop);
      const dt = Math.min((t - last) / 1000, 0.05);
      last = t;
      const st = s.current;
      const { live, claims } = server.current;

      // my bowl
      const dx = direction(keys).x;
      if (dx) (st.target = null), (st.x += dx * 800 * dt);
      else if (st.target != null) st.x += Math.sign(st.target - st.x) * Math.min(Math.abs(st.target - st.x), 1200 * dt);
      st.x = Math.max(BOWL / 2, Math.min(W - BOWL / 2, st.x));

      // other bowls glide toward where the server last saw them (no jumping)
      const glide = 1 - Math.exp(-dt * 14);
      for (const [id, l] of Object.entries(live)) {
        if (id === me || l?.x == null) continue;
        st.shownX[id] = st.shownX[id] == null ? l.x : st.shownX[id] + (l.x - st.shownX[id]) * glide;
      }

      // the canvas follows the field's size (and stays sharp on phones / retina screens)
      const el = canvas.current;
      if (!el) return;
      const pxW = Math.round(el.clientWidth * devicePixelRatio);
      const pxH = Math.round(el.clientHeight * devicePixelRatio);
      if (el.width !== pxW || el.height !== pxH) (el.width = pxW), (el.height = pxH);
      const scale = pxW / W;
      if (!sprites || Math.abs(sprites.size - BALL * scale) > 0.5) sprites = makeSprites(BALL * scale);
      ctx.clearRect(0, 0, pxW, pxH);

      const serverTime = now();
      const time = (serverTime - game.startAt) / 1000;
      const running = time > 0 && serverTime < game.endsAt;
      const pulse = 0.5 + 0.5 * Math.sin(t / (dark ? 95 : 127)); // golden glow

      for (const b of balls) {
        const y = (time - b.at) * b.speed;
        if (y < -BALL || y > H + BALL) continue;
        if (st.mine.has(b.id) || st.guessed.has(b.id)) continue;
        const owner = claims[b.id];
        if (owner && owner !== me) continue; // someone else has it

        if (running && inBand(y)) {
          if (touches(b, st.x)) {
            // Mine! (unless the server says someone else was first)
            st.mine.add(b.id);
            st.pending.set(b.id, Date.now());
            st.pops.push({ x: b.x, y: BOWL_Y - 40, text: b.gold ? "+5" : "+1", color: b.gold ? "#d99a00" : "#0058a3", t0: t });
            sendRef.current();
            rerender();
            continue;
          }
          // In another bowl? Then it's gone for me too.
          if (Object.keys(st.shownX).some((id) => live[id] && touches(b, st.shownX[id]))) {
            st.guessed.add(b.id);
            continue;
          }
        }

        const px = (b.x - BALL / 2) * scale;
        const py = (y - BALL / 2) * scale;
        if (b.gold) {
          ctx.save();
          ctx.shadowColor = `rgba(255, 200, 40, ${0.55 + 0.4 * pulse})`;
          ctx.shadowBlur = (14 + 16 * pulse) * scale * devicePixelRatio;
          ctx.drawImage(sprites.gold, px, py, sprites.size, sprites.size);
          ctx.restore();
        } else ctx.drawImage(sprites.normal, px, py, sprites.size, sprites.size);
      }

      // floating texts
      st.pops = st.pops.filter((p) => t - p.t0 < 900);
      ctx.textAlign = "center";
      ctx.font = `900 ${Math.max(12, 30 * scale)}px system-ui, sans-serif`;
      for (const p of st.pops) {
        const k = Math.max(0, (t - p.t0) / 900);
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, p.x * scale, (p.y - 60 * k) * scale);
      }
      ctx.globalAlpha = 1;

      // move the bowls (straight on the elements, no React)
      for (const [id, node] of Object.entries(bowlEls.current)) {
        const x = id === me ? st.x : st.shownX[id];
        if (node && x != null) node.style.transform = bowlTransform(x);
      }
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [balls, game.startAt, game.endsAt, keys, now, me, dark]);

  // Scores: the server's claims, plus my catches that are still on their way
  const byPlayer = caughtBy(claims);
  const myBalls = [...new Set([...(byPlayer[me] ?? []), ...s.current.mine])];
  const scores = game.playerIds
    .map((id) => ({ id, score: scoreOf(balls, id === me ? myBalls : byPlayer[id]) }))
    .sort((a, b) => b.score - a.score);

  const time = (now() - game.startAt) / 1000;
  const others = game.playerIds.filter((id) => id !== me && live[id]?.x != null);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-sm font-bold">
        {scores.map(({ id, score }) => (
          <span key={id} className={`rounded-full px-3 py-1 ${id === me ? "bg-yellow text-[#111]" : "bg-page"}`}>
            {room.players[id]?.name} {score}
          </span>
        ))}
        <span className="ml-auto rounded-full bg-ink px-3 py-1 text-page">{Math.max(0, Math.ceil((game.endsAt - now()) / 1000))}s</span>
      </div>

      <div
        ref={field}
        onPointerMove={(e) => {
          const r = field.current.getBoundingClientRect();
          s.current.target = ((e.clientX - r.left) / r.width) * W;
        }}
        className={`relative w-full touch-none select-none overflow-hidden rounded-xl ${dark ? "bg-[#0b0e13]" : "bg-page"}`}
        style={{ aspectRatio: `${W} / ${H}` }}
      >
        <canvas ref={canvas} className="absolute inset-0 h-full w-full" />

        {[...others, me].map((id) => {
          const x = id === me ? s.current.x : (s.current.shownX[id] ?? live[id].x);
          return (
            <div
              key={id}
              ref={(node) => {
                if (node) bowlEls.current[id] = node;
                else delete bowlEls.current[id];
              }}
              className={`absolute left-0 flex flex-col items-center will-change-transform ${id === me ? "z-10" : "opacity-60"}`}
              style={{ top: pct(BOWL_Y - 30, H), width: pct(BOWL, W), transform: bowlTransform(x) }}
            >
              <Furniture id={room.players[id]?.character} className="h-[45%] w-[45%]" />
              <svg viewBox="0 0 140 48" className="-mt-1 w-full drop-shadow">
                <path d="M4 6 H136 C132 34 108 46 70 46 C32 46 8 34 4 6 Z" fill="#fff" stroke="#111" strokeWidth="4" />
                <path d="M16 16 H124" stroke="#0058a3" strokeWidth="5" />
              </svg>
              <span className="text-[clamp(8px,1vw,12px)] font-bold">{id === me ? "You" : room.players[id]?.name}</span>
            </div>
          );
        })}

        {time < 0 && (
          <p className="absolute inset-0 grid place-items-center text-6xl font-black text-blue">{Math.ceil(-time)}</p>
        )}
      </div>
      <p className="text-sm text-muted">Move with A / D, the arrow keys, your mouse or your finger. Grab the meatballs before the others do!</p>
    </div>
  );
}
