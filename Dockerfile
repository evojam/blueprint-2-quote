FROM node:24-alpine AS builder

ENV NEXT_TELEMETRY_DISABLED=1 \
    PATH=/app/node_modules/.bin:$PATH
ARG OPEN_MERCATO_DOCKER_REGISTRY_HOST=host.docker.internal
ARG NEXT_PUBLIC_DOCUMENTS_COLLAB_URL
ENV NEXT_PUBLIC_DOCUMENTS_COLLAB_URL=${NEXT_PUBLIC_DOCUMENTS_COLLAB_URL}

WORKDIR /app

RUN apk add --no-cache python3 make g++ ca-certificates openssl
RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
RUN if grep -Eq 'http://(localhost|127\\.0\\.0\\.1):' .yarnrc.yml; then \
      sed \
        -e "s#http://localhost:#http://${OPEN_MERCATO_DOCKER_REGISTRY_HOST}:#g" \
        -e "s#http://127.0.0.1:#http://${OPEN_MERCATO_DOCKER_REGISTRY_HOST}:#g" \
        .yarnrc.yml > .yarnrc.yml.container; \
      if ! grep -Eq '^checksumBehavior:' .yarnrc.yml.container; then \
        printf '\nchecksumBehavior: update\n' >> .yarnrc.yml.container; \
      fi; \
      mv .yarnrc.yml.container .yarnrc.yml; \
    fi
RUN yarn install

COPY . .
RUN yarn generate
RUN NODE_ENV=production yarn build
# Turbopack's build cache is 645 MB of the 999 MB under .mercato/next and is dead
# weight at runtime. Dropping it here, in the builder, keeps it out of the copy
# below — deleting it after the COPY would leave it in the layer underneath.
RUN rm -rf /app/.mercato/next/cache

FROM node:24-alpine AS dev

ENV NODE_ENV=development \
    NEXT_TELEMETRY_DISABLED=1 \
    PATH=/app/node_modules/.bin:$PATH
ARG OPEN_MERCATO_DOCKER_REGISTRY_HOST=host.docker.internal

WORKDIR /app

RUN apk add --no-cache python3 make g++ ca-certificates openssl
RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
RUN if grep -Eq 'http://(localhost|127\\.0\\.0\\.1):' .yarnrc.yml; then \
      sed \
        -e "s#http://localhost:#http://${OPEN_MERCATO_DOCKER_REGISTRY_HOST}:#g" \
        -e "s#http://127.0.0.1:#http://${OPEN_MERCATO_DOCKER_REGISTRY_HOST}:#g" \
        .yarnrc.yml > .yarnrc.yml.container; \
      if ! grep -Eq '^checksumBehavior:' .yarnrc.yml.container; then \
        printf '\nchecksumBehavior: update\n' >> .yarnrc.yml.container; \
      fi; \
      mv .yarnrc.yml.container .yarnrc.yml; \
    fi
RUN yarn install

COPY . .

COPY docker/scripts/dev-entrypoint.sh /app/docker/scripts/dev-entrypoint.sh
COPY docker/scripts/init-or-migrate.sh /app/docker/scripts/init-or-migrate.sh
COPY docker/scripts/mcp-entrypoint.sh /app/docker/scripts/mcp-entrypoint.sh
RUN chmod +x /app/docker/scripts/dev-entrypoint.sh
RUN chmod +x /app/docker/scripts/init-or-migrate.sh
RUN chmod +x /app/docker/scripts/mcp-entrypoint.sh

EXPOSE 3000 4101
CMD ["/bin/sh", "/app/docker/scripts/dev-entrypoint.sh"]

FROM node:24-alpine AS runner

ARG CONTAINER_PORT=3000
ARG DOCUMENTS_COLLAB_PORT=4101
ARG OPEN_MERCATO_DOCKER_REGISTRY_HOST=host.docker.internal

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PATH=/app/node_modules/.bin:$PATH \
    PORT=${CONTAINER_PORT} \
    HOSTNAME=0.0.0.0 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Chromium backs the Documents PDF export (puppeteer-core); the fonts keep
# rendered text from coming out as empty boxes on Alpine.
RUN apk add --no-cache ca-certificates chromium font-noto ttf-freefont openssl
RUN corepack enable

# The runtime user is created before anything lands in /app, and every later step
# runs as that user. A trailing `RUN chown -R omuser:omuser /app` would instead
# rewrite every file it touches into a fresh layer — ~2.8 GB of pure duplication
# on top of the ~2.7 GB the tree already costs.
RUN adduser -D -u 1001 omuser \
 && mkdir -p /app \
 && chown omuser:omuser /app
USER omuser
WORKDIR /app

COPY --chown=omuser:omuser package.json yarn.lock .yarnrc.yml ./
RUN if grep -Eq 'http://(localhost|127\\.0\\.0\\.1):' .yarnrc.yml; then \
      sed \
        -e "s#http://localhost:#http://${OPEN_MERCATO_DOCKER_REGISTRY_HOST}:#g" \
        -e "s#http://127.0.0.1:#http://${OPEN_MERCATO_DOCKER_REGISTRY_HOST}:#g" \
        .yarnrc.yml > .yarnrc.yml.container; \
      if ! grep -Eq '^checksumBehavior:' .yarnrc.yml.container; then \
        printf '\nchecksumBehavior: update\n' >> .yarnrc.yml.container; \
      fi; \
      mv .yarnrc.yml.container .yarnrc.yml; \
    fi
RUN yarn workspaces focus --all --production

COPY --chown=omuser:omuser --from=builder /app/.mercato/next ./.mercato/next
COPY --chown=omuser:omuser --from=builder /app/public ./public
COPY --chown=omuser:omuser --from=builder /app/src ./src
COPY --chown=omuser:omuser --from=builder /app/types ./types
COPY --chown=omuser:omuser --from=builder /app/.mercato ./.mercato
COPY --chown=omuser:omuser --from=builder /app/next.config.ts ./next.config.ts
COPY --chown=omuser:omuser --from=builder /app/postcss.config.mjs ./postcss.config.mjs
COPY --chown=omuser:omuser --from=builder /app/components.json ./components.json
COPY --chown=omuser:omuser --from=builder /app/tsconfig.json ./tsconfig.json
COPY --chown=omuser:omuser --from=builder /app/scripts ./scripts
# --chmod sets the executable bit during the copy, so no extra chmod layer is needed.
COPY --chown=omuser:omuser --chmod=755 docker/scripts/init-or-migrate.sh /app/docker/scripts/init-or-migrate.sh
# Used by the optional `mcp` service (compose profile `agents`).
COPY --chown=omuser:omuser --chmod=755 docker/scripts/mcp-entrypoint.sh /app/docker/scripts/mcp-entrypoint.sh

EXPOSE ${CONTAINER_PORT} ${DOCUMENTS_COLLAB_PORT}
CMD ["yarn", "start"]
