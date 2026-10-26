# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
# npm run build = tsc + src/scripts/build-site.mjs, which fetches the pinned
# upstream WASM zips plus the fork's bridge scripts and portal shell over HTTPS
# (the Docker build context is only server/, so repo files are not available).
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Combined single-service site: served by the relay's portal middleware when
# present; a standalone relay ignores the directory (PORTAL_DIR mount is
# guarded by the existence of site/bridge/loader.js).
COPY --from=build /app/site ./site
EXPOSE 8080
CMD ["node", "dist/index.js"]
