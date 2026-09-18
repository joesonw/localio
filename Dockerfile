# syntax=docker/dockerfile:1

# better-sqlite3 is the one native module here, and its binary is tied to both the
# Node major and the platform — so the stage that compiles it and the stage that runs
# it are the same image.
ARG NODE_IMAGE=node:20-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app

# A prebuilt better_sqlite3.node exists for linux/amd64 and linux/arm64, but the
# toolchain is here so that a build from source is a slow path rather than a failure.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# tsc, then the copy of src/db/*.sql into dist/db — open.ts reads those relative to
# its own module, so they have to travel with it.
RUN npm run build

# Drop devDependencies from the tree we just compiled, rather than resolving a second
# one: this keeps the native binary the one that was built against this image.
RUN npm prune --omit=dev


FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# server.ts resolves the handset as `../public` relative to its own module, so public/
# must be a sibling of dist/, not inside it.
COPY public ./public
COPY package.json ./

# HOST is loopback by default, which in a container is unreachable. Widening it trips
# the "nothing here is authenticated" warning on boot — that warning is correct: this
# is a development tool, publish the port to localhost only.
ENV HOST=0.0.0.0 \
    PORT=8080 \
    DB=/data/localio.db \
    RECORDINGS_DIR=/data/recordings

# SQLite runs in WAL mode, so the volume holds localio.db plus its -wal and -shm.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
USER node

EXPOSE 8080
CMD ["node", "dist/index.js"]
