# ApplyOps CLI / apply-agent image — spec §10, plan Task 15 Step 3.
#
# What this image is for: running `applyops apply` (and the other operator
# commands) with a real Chromium, on a machine that is not the owner's laptop.
# It is NOT a web-app image — the Next.js app is deployed to Vercel (spec §12).
#
# The base is Microsoft's official Playwright image at exactly the version in
# package.json. Playwright refuses to drive a browser whose build does not
# match the client library, so this tag and `"playwright": "^1.62.1"` have to
# be bumped together — that is the one maintenance obligation of this file.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

# Browsers are already baked into the base image at /ms-playwright; without
# this, `npm ci` would download a second copy (~400 MB) into the layer.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=development

# Dependencies first, so a source-only change reuses this layer. Dev
# dependencies are installed on purpose: the CLI runs through `tsx`, which is
# a devDependency, so `--omit=dev` would produce an image that cannot start.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# A container has nobody at the terminal to answer the `y/N` approval prompt,
# so the agent is forced into dry-run mode here (spec §10: "--dry-run default
# in Docker"). `cli/commands/apply.ts` reads this; overriding it is a
# deliberate act (`-e APPLYOPS_FORCE_DRY_RUN=0`) by someone who has arranged
# for an interactive TTY.
ENV APPLYOPS_FORCE_DRY_RUN=1

# Run as the base image's non-root user so Chromium keeps its own sandbox. If
# your runtime forces root (some CI executors do), Chromium's sandbox cannot
# initialise — set APPLYOPS_BROWSER_NO_SANDBOX=1 at `docker run` time, which
# src/agent/run.ts turns into --no-sandbox. Don't do that on a host where the
# pages being visited are not trusted.
USER pwuser
ENV HOME=/home/pwuser

# Secrets are never baked in (.dockerignore keeps .env* out of the context):
#   docker run --rm -it --env-file .env.local applyops apply <id> --headless
ENTRYPOINT ["npm", "run", "cli", "--"]
CMD ["--help"]
