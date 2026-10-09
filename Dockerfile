# FractalAI MCP server — stdio transport
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npx tsc

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# MCP stdio server: clients speak JSON-RPC over stdin/stdout.
# The startup banner is written to stderr, so stdout stays pure JSON-RPC.
ENTRYPOINT ["node", "dist/index.js"]
