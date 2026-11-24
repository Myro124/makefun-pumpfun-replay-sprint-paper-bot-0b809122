// Early Traction Rider — pump.fun replay paper bot (agent-fun/replay/v2).
// Run by the grader as `node /bot/main.ts`; the strategy lives in strategy.ts
// and the SDK shim is vendored byte for byte in vendor/makefun-bot.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
