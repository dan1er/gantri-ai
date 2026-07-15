# Based on Playwright's official image for Node 20 + Chromium preinstalled
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

# Install deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source & build (backend)
COPY tsconfig.json ./
COPY src ./src
# tsc emits .js only — copy the runtime prompt markdown into dist/prompts so the
# /review-flc review standard ships in the image (loaded relative to dist/flc/).
RUN npm install --no-save typescript@5 && npx tsc \
  && mkdir -p dist/prompts && cp src/prompts/*.md dist/prompts/

# Build web SPA (Vite + React + Tailwind + Tremor) — outputs web/dist
COPY web ./web
RUN cd web && npm install --no-audit --no-fund && npm run build

# Prune dev deps after both builds
RUN npm prune --omit=dev

# Bake the build fingerprint read by GET /internal/build. CI passes the commit
# via `flyctl deploy --build-arg GIT_SHA=<github.sha>` (see fly-deploy.yml); a
# hand-run `fly deploy` without the arg falls back to "unknown", which is still
# useful because the `modules` health signal is what the deploy canary checks.
# Placed last so a new sha only rebuilds this tiny layer, not the npm/build ones.
ARG GIT_SHA=unknown
RUN printf '{"sha":"%s","builtAt":"%s"}\n' "$GIT_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > build-info.json

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
