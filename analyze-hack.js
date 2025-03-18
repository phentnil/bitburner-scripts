import {
  getConfiguration,
  disableLogs,
  formatMoney as importedFormatMoney,
  formatDuration,
  scanAllServers,
} from './helpers.js';

const argsSchema = [
  ['all', false], // Set to true to report on all servers, not just the ones within our hack level
  ['silent', false], // Set to true to disable outputting the best servers to the terminal
  ['at-hack-level', 0], // Simulate expected gains when the player reaches the specified hack level. 0 means use the player's current hack level.
  ['hack-percent', -1], // Compute gains when hacking a certain percentage of each server's money. -1 estimates hack percentage based on current ram available, capped at 98%
  ['include-hacknet-ram', false], // Whether to include hacknet servers' RAM when computing current ram available
  ['disable-formulas-api', false], // Disables use of the formulas API even if it is available (useful for debugging the fallback logic used when formulas is unavailable)
];

export function autocomplete(data, args) {
  data.flags(argsSchema);
  return [];
}

/** @param {NS} ns **/
export async function main(ns) {
  const options = getConfiguration(ns, argsSchema);
  if (!options) return; // Invalid options, or ran in --help mode.
  disableLogs(ns, ['scan', 'sleep']);

  let serverNames = ['']; // Provide a type hint to the IDE
  serverNames = scanAllServers(ns);

  const weakenRam = 1.75;
  const growRam = 1.75;
  const hackRam = 1.7;

  let hackPercent = options['hack-percent'] / 100;
  let useEstHackPercent = false;
  if (options['hack-percent'] === -1) {
    useEstHackPercent = true;
  } else {
    hackPercent = options['hack-percent'] / 100;
    if (hackPercent <= 0 || hackPercent >= 1) {
      ns.tprint('hack-percent out of range (0-100)');
      return;
    }
  }

  const player = ns.getPlayer();
  //ns.print(JSON.stringify(player));

  if (options['at-hack-level'])
    player.skills.hacking = options['at-hack-level'];
  let servers = serverNames.map(ns.getServer);
  // Compute the total RAM available to us on all servers (e.g. for running hacking scripts)
  const ramTotal = servers.reduce((total, server) => {
    if (
      !server.hasAdminRights ||
      (server.hostname.startsWith('hacknet') && !options['include-hacknet-ram'])
    )
      return total;
    return total + server.maxRam;
  }, 0);

  // Override the imported formatMoney to handle amounts less than 0.01:
  const formatMoney = (amt) =>
    amt > 0.01 ? importedFormatMoney(amt) : '$' + amt.toPrecision(3);

  /** Helper to compute server gain/exp rates at a specific hacking level
   * @param {Server} server
   * @param {Player} player */
  function getRatesAtHackLevel(server, player, hackLevel) {
    let theoreticalGainRate, cappedGainRate, expRate;
    let useFormulas = !options['disable-formulas-api'];
    if (useFormulas) {
      // Temporarily change the hack level on the player object to the requested level
      const realPlayerHackSkill = player.skills.hacking;
      player.skills.hacking = hackLevel;
      // Assume we will have wekened the server to min-security and taken it to max money before targetting
      server.hackDifficulty = server.minDifficulty;
      server.moneyAvailable = server.moneyMax;
      try {
        // Compute the cost (ram*seconds) for each tool
        const weakenCost =
          weakenRam * ns.formulas.hacking.weakenTime(server, player);
        const growCost =
          growRam * ns.formulas.hacking.growTime(server, player) +
          (weakenCost * 0.004) / 0.05;
        const hackCost =
          hackRam * ns.formulas.hacking.hackTime(server, player) +
          (weakenCost * 0.002) / 0.05;

        // Compute the growth and hack gain rates
        const growGain = Math.log(
          ns.formulas.hacking.growPercent(server, 1, player, 1),
        );
        const hackGain = ns.formulas.hacking.hackPercent(server, player);
        // If hack gain is less than this minimum (very high BN12 levels?) We must coerce it to some minimum value to avoid NAN results.
        const minHackGain = 1e-10;
        if (hackGain <= minHackGain)
          ns.print(
            `WARN: hackGain is ${hackGain.toPrecision(
              3,
            )}. Coercing it to the minimum value ${minHackGain} (${
              server.hostname
            })`,
          );
        server.estHackPercent = Math.max(
          minHackGain,
          Math.min(
            0.98,
            Math.min(
              (ramTotal * hackGain) / hackCost,
              1 - 1 / Math.exp((ramTotal * growGain) / growCost),
            ),
          ),
        );
        if (useEstHackPercent) hackPercent = server.estHackPercent;
        const growsPerCycle = -Math.log(1 - hackPercent) / growGain;
        const hacksPerCycle = hackPercent / hackGain;
        const hackProfit =
          server.moneyMax *
          hackPercent *
          ns.formulas.hacking.hackChance(server, player);
        // Compute the relative monetary gain
        theoreticalGainRate =
          (hackProfit / (growCost * growsPerCycle + hackCost * hacksPerCycle)) *
          1000 /* Convert per-millisecond rate to per-second */;
        expRate =
          ((ns.formulas.hacking.hackExp(server, player) * (1 + 0.002 / 0.05)) /
            hackCost) *
          1000;
        // The practical cap on revenue is based on your hacking scripts. For my hacking scripts this is about 20% per second, adjust as needed
        // No idea why we divide by ram_total - Basically ensures that as our available RAM gets larger, the sort order merely becomes "by server max money"
        cappedGainRate = Math.min(theoreticalGainRate, hackProfit / ramTotal);
        ns.print(
          `At hack level ${hackLevel} and steal ${(
            hackPercent * 100
          ).toPrecision(3)}%: ` +
            `Theoretical ${formatMoney(
              theoreticalGainRate,
            )}, Limit: ${formatMoney(
              hackProfit / ramTotal,
            )}, Exp: ${expRate.toPrecision(3)}, ` +
            `Hack Chance: ${(
              ns.formulas.hacking.hackChance(server, player) * 100
            ).toPrecision(3)}% (${server.hostname})`,
        );
      } catch {
        // Formulas API unavailable?
        useFormulas = false;
      } finally {
        player.skills.hacking = realPlayerHackSkill; // Restore the real hacking skill if we changed it temporarily
      }
    }
    // Solution for when formulas API is disabled or unavailable
    if (!useFormulas) {
      // Fall-back to returning a "gain rates" based purely on current hack time (i.e. ignoring the RAM associated with required grow/weaken threads)
      const timeToHack = ns.getWeakenTime(server.hostname) / 4.0;
      // Realistically, batching scripts run on carefully timed intervals (e.g. batches scheduled no less than 200 ms apart).
      // So for very small time-to-weakens, we use a "capped" gain rate based on a more achievable number of hacks per second.
      const cappedTimeToHack = Math.max(timeToHack, 200);
      // the server computes experience gain based on the server's base difficulty. To get a rate, we divide that by the timeToWeaken
      const relativeExpGain = 3 + server.minDifficulty * 0.3; // Ignore HackExpGain mults since they affect all servers equally
      server.estHackPercent = 1; // Our simple calculations below are based on 100% of server money on every server.
      [theoreticalGainRate, cappedGainRate, expRate] = [
        server.moneyMax / timeToHack,
        server.moneyMax / cappedTimeToHack,
        relativeExpGain / timeToHack,
      ];
      ns.print(
        `Without formulas.exe, based on max money ${formatMoney(
          server.moneyMax,
        )} and hack-time ${formatDuration(
          timeToHack,
        )} (capped at ${formatDuration(cappedTimeToHack)})): ` +
          `Theoretical ${formatMoney(
            theoreticalGainRate,
          )}, Limit: ${formatMoney(cappedGainRate)}, Exp: ${expRate.toPrecision(
            3,
          )} (${server.hostname})`,
      );
    }
    return [theoreticalGainRate, cappedGainRate, expRate];
  }

  ns.print(
    `All? ${options['all']} Player hack: ${player.skills.hacking} Ram total: ${ramTotal}`,
  );
  //ns.print(`\n` + servers.map(s => `${s.hostname} bought: ${s.purchasedByPlayer} moneyMax: ${s.moneyMax} admin: ${s.hasAdminRights} hack: ${s.requiredHackingSkill}`).join('\n'));

  // Filter down to the list of servers we wish to report on
  servers = servers.filter(
    (server) =>
      !server.purchasedByPlayer &&
      (server.moneyMax || 0) > 0 &&
      (options['all'] ||
        (server.hasAdminRights &&
          server.requiredHackingSkill <= player.skills.hacking)),
  );

  // First address the servers within our hacking level
  const unlockedServers = servers
    .filter((s) => s.requiredHackingSkill <= player.skills.hacking)
    .map((server) => {
      [server.theoreticalGainRate, server.gainRate, server.expRate] =
        getRatesAtHackLevel(server, player, player.skills.hacking);
      return server;
    });
  // The best server's gain rate will be used to pro-rate the relative gain of servers that haven't been unlocked yet (if they were unlocked at this level)
  const bestUnlockedServer = unlockedServers.toSorted(
    (a, b) => b.gainRate - a.gainRate,
  )[0];
  ns.print(
    'Best unlocked server: ',
    bestUnlockedServer.hostname,
    ' with ',
    formatMoney(bestUnlockedServer.gainRate),
    ' per ram-second',
  );
  // Compute locked server's gain rates (pro rated back to the current player's hack level)
  const lockedServers =
    servers
      .filter((s) => s.requiredHackingSkill > player.skills.hacking)
      .sort((a, b) => a.requiredHackingSkill - b.requiredHackingSkill)
      .map((server) => {
        // We will need to fake the hacking skill to get the numbers for when this server will first be unlocked, but to keep the comparison
        // fair, we will need to scale down the gain by the amount current best server gains now, verses what it would gain at that hack level.
        const [bestUnlockedScaledGainRate, _, bestUnlockedScaledExpRate] =
          getRatesAtHackLevel(
            bestUnlockedServer,
            player,
            server.requiredHackingSkill,
          );
        const gainRateScaleFactor = bestUnlockedScaledGainRate
          ? bestUnlockedServer.theoreticalGainRate / bestUnlockedScaledGainRate
          : 1;
        const expRateScaleFactor = bestUnlockedScaledExpRate
          ? bestUnlockedServer.expRate / bestUnlockedScaledExpRate
          : 1;
        const [theoreticalGainRate, cappedGainRate, expRate] =
          getRatesAtHackLevel(server, player, server.requiredHackingSkill);
        // Apply the scaling factors, as well as the same cap as above
        server.theoreticalGainRate = theoreticalGainRate * gainRateScaleFactor;
        server.expRate = expRate * expRateScaleFactor;
        server.gainRate = Math.min(server.theoreticalGainRate, cappedGainRate);
        ns.print(
          `${
            server.hostname
          }: Scaled theoretical gain by ${gainRateScaleFactor.toPrecision(
            3,
          )} to ${formatMoney(server.theoreticalGainRate)} ` +
            `(capped at ${formatMoney(
              cappedGainRate,
            )}) and exp by ${expRateScaleFactor.toPrecision(
              3,
            )} to ${server.expRate.toPrecision(3)}`,
        );
        return server;
      }) || [];
  // Combine the lists, sort, and display a summary.
  const serverEval = unlockedServers.concat(lockedServers);
  const bestServer = serverEval.toSorted((a, b) => b.gainRate - a.gainRate)[0];
  if (!options['silent'])
    ns.tprint(
      'Best server: ',
      bestServer.hostname,
      ' with ',
      formatMoney(bestServer.gainRate),
      ' per ram-second',
    );

  // Print all servers by best to work hack money value
  let order = 1;
  let serverListByGain = `Servers in order of best to worst hack money at Hack ${player.skills.hacking}:`;
  for (const server of serverEval)
    serverListByGain +=
      `\n ${order++} ${server.hostname}, with ${formatMoney(
        server.gainRate,
      )} per ram-second while stealing ` +
      `${(server.estHackPercent * 100).toPrecision(3)}% (unlocked at hack ${
        server.requiredHackingSkill
      })`;
  ns.print(serverListByGain);

  // Reorder servers by exp and sort by best to work hack experience gain rate
  const bestExpServer = serverEval.toSorted((a, b) => b.expRate - a.expRate)[0];
  if (!options['silent'])
    ns.tprint(
      'Best exp server: ',
      bestExpServer.hostname,
      ' with ',
      bestExpServer.expRate,
      ' exp per ram-second',
    );
  order = 1;
  let serverListByExp = `Servers in order of best to worst hack exp at Hack ${player.skills.hacking}:`;
  for (let i = 0; i < Math.min(5, serverEval.length); i++)
    serverListByExp += `\n ${order++} ${
      serverEval[i].hostname
    }, with ${serverEval[i].expRate.toPrecision(3)} exp per ram-second`;
  ns.print(serverListByExp);

  ns.write(
    '/Temp/analyze-hack.txt',
    JSON.stringify(
      serverEval.map((s) => ({
        hostname: s.hostname,
        gainRate: s.gainRate,
        expRate: s.expRate,
      })),
    ),
    'w',
  );
}
