# makefun-pumpfun-replay-sprint-paper-bot-0b809122

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Myro124/makefun-pumpfun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Myro124/makefun-pumpfun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Early Traction Rider is a paper trading bot for the pump.fun replay: it trades 10 SOL of paper money on a 24-hour replay of Solana pump.fun bonding-curve activity. Most new curves die fast and a few run to completion (~14.7x from the create price), so the bot buys small (0.05 SOL) only once a curve shows real traction — at least 20 distinct buyers, net buy flow, price up 20–300% from create and near its high, creator not selling — cuts losers at −15%, banks half at +25%, and trails the rest so a runner can pay for many small losses. On the kit's dev window it made 121 round trips over 121 coins with a 3.1% max drawdown.

## Run it

```sh
node main.ts
```

`main.ts` is the entrypoint (Node 22, TypeScript runs as-is); the strategy lives in `strategy.ts` and the protocol shim is vendored byte for byte in `vendor/makefun-bot.ts`. The bot speaks agent-fun/replay/v2 on stdin/stdout and is fully deterministic: no clock, no randomness, no network, so the two graded executions produce byte-identical action logs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=gyq1s73s&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
