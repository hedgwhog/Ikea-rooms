import { catchGame } from "./catch.js";
import { priceGame } from "./price.js";
import { sofaGame } from "./sofa.js";
import { bumperGame } from "./bumper.js";
import { hideGame } from "./hide.js";
import { sniperGame } from "./sniper.js";
import { runnerGame } from "./runner.js";

// Every game has the same shape:
//   init(players, now, { products })  -> new game state
//   act(game, playerId, action, now)  -> a player clicked/guessed (optional)
//   tick(game, now, live, claims)     -> time passed; returns true if something changed
//   score(game, id)                   -> how well a player did (higher = better, same = tie)
export const ENGINES = { catch: catchGame, price: priceGame, sofa: sofaGame, bumper: bumperGame, hide: hideGame, sniper: sniperGame, runner: runnerGame };
export const USES_LIVE = new Set(["catch", "bumper", "sniper", "runner"]); // games that send positions many times a second
export const USES_CLAIMS = new Set(["catch"]); // games where only the FIRST player to grab something gets it
