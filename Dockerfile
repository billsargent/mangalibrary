# Manga Library in a container: the server and the web UI it serves.
#
#   docker build -t mangalibrary .
#   docker run -d --name mangalibrary -p 25600:25600 \
#     -v /srv/mangalibrary:/data -v /srv/manga:/books:ro mangalibrary
#
# Then add a library whose folder is /books (or a folder inside it). Everything the
# server keeps - the database, its settings, fonts - is in /data; back that up.

# --- Build: the server and the UI, from source -------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Dependencies first, so a change to the source does not reinstall them.
COPY server/package.json server/package-lock.json server/
COPY ui/package.json ui/package-lock.json ui/
RUN npm --prefix server ci && npm --prefix ui ci

COPY server server
COPY ui ui
RUN npm --prefix server run build && npm --prefix ui run build \
  && npm --prefix server prune --omit=dev

# --- Run: only what the running server needs ---------------------------------------
FROM node:22-bookworm-slim
WORKDIR /app

COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/ui/dist ui/dist

ENV NODE_ENV=production \
    MANGALIBRARY_CONFIG_DIR=/data \
    SERVER_PORT=25600 \
    SERVER_HOST=0.0.0.0
RUN mkdir -p /data /books && chown node:node /data
VOLUME ["/data"]
EXPOSE 25600

# Not root. Run with --user to match the owner of the folders you mount, if theirs
# is not uid 1000.
USER node
CMD ["node", "server/dist/index.js"]
