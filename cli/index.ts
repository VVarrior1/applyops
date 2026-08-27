#!/usr/bin/env tsx
import { config } from "dotenv";
config({ path: ".env.local" });
import { Command } from "commander";
import { registrars } from "./commands";

const program = new Command();
program.name("applyops").description("ApplyOps operator CLI").version("0.1.0");
for (const register of registrars) register(program);
program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
