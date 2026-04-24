# Based on Playwright's official image for Node 20 + Chromium preinstalled
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

# Install deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source & build
COPY tsconfig.json ./
COPY src ./src
RUN npm install --no-save typescript@5 && npx tsc && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
