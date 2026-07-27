# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM docker.io/library/node:22.23.1-alpine3.24@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build

ARG SOURCE_REVISION

ENV ASTRO_TELEMETRY_DISABLED=1 \
    CI=true \
    NX_DAEMON=false

WORKDIR /workspace

RUN if ! printf '%s\n' "${SOURCE_REVISION}" | grep -Eq '^[0-9a-f]{40}$'; then \
      echo "SOURCE_REVISION must be a full 40-character lowercase Git commit SHA" >&2; \
      exit 64; \
    fi

COPY package.json package-lock.json nx.json tsconfig.json tsconfig.base.json ./
COPY apps/wiki/package.json apps/wiki/package.json
COPY libs/cli/package.json libs/cli/package.json

RUN npm ci --no-audit --no-fund

COPY apps/wiki apps/wiki

RUN npm run wiki:build \
    && test -f dist/apps/wiki/index.html \
    && printf '%s\n' \
      '{' \
      '  "schemaVersion": 1,' \
      '  "siteId": "skill-sync-docs",' \
      '  "source": {' \
      '    "repository": "https://github.com/moonryc/skill-sync",' \
      '    "path": "apps/wiki",' \
      "    \"revision\": \"${SOURCE_REVISION}\"" \
      '  }' \
      '}' \
      >dist/apps/wiki/provenance.json

FROM docker.io/nginxinc/nginx-unprivileged:1.31.3-alpine3.24-slim@sha256:22f839c5fb4007dc24d203a170a9e03fc185d660bfefc34ac6823a7aef085cbc AS runtime

ARG SOURCE_REVISION

USER root
RUN rm -rf \
      /etc/apk \
      /lib/apk \
      /sbin/apk \
      /var/cache/apk \
      /usr/share/nginx/html/*

LABEL org.opencontainers.image.title="Skill Sync documentation" \
      org.opencontainers.image.description="Static Skill Sync Astro and Starlight documentation" \
      org.opencontainers.image.source="https://github.com/moonryc/skill-sync" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      io.skill-sync.docs.source.path="apps/wiki"

COPY --chown=101:101 apps/wiki/nginx.container.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=101:101 /workspace/dist/apps/wiki/ /usr/share/nginx/html/

USER 101:101
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["wget", "--quiet", "--spider", "http://127.0.0.1:8080/healthz"]
