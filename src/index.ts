import { registerCommands } from "./bot/commands.js";
import { TrustContractBot } from "./bot/app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { JsonStore } from "./storage/JsonStore.js";

async function main(): Promise<void> {
  const store = new JsonStore(config.storeFile);
  const commandsRegistered = await registerCommands(config);
  if (commandsRegistered) {
    logger.info("Slash commands registered.");
  }

  const app = new TrustContractBot(config, store);
  app.start();
  await app.login();
}

main().catch((error) => {
  logger.error("Fatal startup error", {
    error: error instanceof Error ? error.stack ?? error.message : String(error)
  });
  process.exitCode = 1;
});
