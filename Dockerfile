FROM node:24.16.0-bookworm-slim AS base
WORKDIR /app
RUN npm install --global pnpm@11.7.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS production-dependencies
RUN pnpm install --frozen-lockfile --prod

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM node:24.16.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
