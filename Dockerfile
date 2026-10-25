# syntax=docker/dockerfile:1

# ---- Stage 1: fetch pinned upstream release artifacts ----
# Versions are bare semver (no "v"); release tags are v${VER} and assets are
# ${repo}-web-${VER}.zip per upstream packaging convention.
FROM alpine:3.20 AS fetch

ARG PHOTOCRAFT_VERSION=0.5.0-main4
ARG LIGHTCRAFT_VERSION=0.4.0
ARG PDFCRAFT_VERSION=0.5.0-main2
ARG VECTORCRAFT_VERSION=0.7.0
ARG FILMCRAFT_VERSION=0.4.0-main
ARG EFFECTCRAFT_VERSION=0.6.0
ARG DESIGNCRAFT_VERSION=0.13.0
ARG FIGCRAFT_VERSION=0.11.2
ARG SOUNDCRAFT_VERSION=0.13.1
ARG CADCRAFT_VERSION=0.13.0
# The FilmCraft, PhotoCraft and PdfCraft web builds that ship the in-page
# agent APIs (window.filmcraft / window.photocraft / window.pdfcraft) are
# published from this repo, not upstream — they carry a "-main" version
# suffix and a commit-tagged asset.
ARG FILMCRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/filmcraft-web-0.4.0-main-7b6c134/filmcraft-web-0.4.0-main.zip"
ARG PHOTOCRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/photocraft-web-0.5.0-main4-0c72d95/photocraft-web-0.5.0-main4.zip"
ARG PDFCRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/pdfcraft-web-0.5.0-main2-23f0675/pdfcraft-web-0.5.0-main2.zip"

RUN apk add --no-cache curl unzip gzip
WORKDIR /site

RUN set -eux; \
    fetch() { \
      repo="$1"; ver="$2"; override="${3:-}"; \
      if [ -n "$override" ]; then url="$override"; \
      else url="https://github.com/storytold/${repo}/releases/download/v${ver}/${repo}-web-${ver}.zip"; fi; \
      echo "fetching ${url}"; \
      curl -fsSL --retry 3 -o /tmp/app.zip "${url}"; \
      unzip -q /tmp/app.zip -d /tmp/app; \
      mv "/tmp/app/${repo}-web-${ver}" "/site/${repo}"; \
      rm -rf /tmp/app /tmp/app.zip; \
    }; \
    fetch photocraft  "${PHOTOCRAFT_VERSION}" "${PHOTOCRAFT_URL}"; \
    fetch lightcraft  "${LIGHTCRAFT_VERSION}"; \
    fetch pdfcraft    "${PDFCRAFT_VERSION}" "${PDFCRAFT_URL}"; \
    fetch vectorcraft "${VECTORCRAFT_VERSION}"; \
    fetch filmcraft   "${FILMCRAFT_VERSION}" "${FILMCRAFT_URL}"; \fetch effectcraft "${EFFECTCRAFT_VERSION}"; \
fetch designcraft "${DESIGNCRAFT_VERSION}"; \
fetch figcraft "${FIGCRAFT_VERSION}"; \
fetch soundcraft "${SOUNDCRAFT_VERSION}"; \
fetch cadcraft "${CADCRAFT_VERSION}"; \
printf '{"photocraft":"v%s","lightcraft":"v%s","pdfcraft":"v%s","vectorcraft":"v%s","filmcraft":"v%s","effectcraft":"v%s","designcraft":"v%s","figcraft":"v%s","soundcraft":"v%s","cadcraft":"v%s"}\n' \
"${PHOTOCRAFT_VERSION}" "${LIGHTCRAFT_VERSION}" "${PDFCRAFT_VERSION}" \
"${VECTORCRAFT_VERSION}" "${FILMCRAFT_VERSION}" "${EFFECTCRAFT_VERSION}" \
"${DESIGNCRAFT_VERSION}" "${FIGCRAFT_VERSION}" "${SOUNDCRAFT_VERSION}" \
"${CADCRAFT_VERSION}" \

      > /site/versions.json

# Craft Relay bridge: static script served same-origin. Inject the script
# tags BEFORE precompressing, so index.html.gz matches the on-disk file.
# RELAY_URL may be absolute (https://relay.example) or relative ("/relay"),
# which resolves against the page origin through nginx's /relay/ proxy.
ARG RELAY_URL="/relay"
COPY bridge/ /site/bridge/
RUN printf 'window.CRAFT_RELAY = { url: "%s" };\n' "$RELAY_URL" > /site/bridge/config.js && \
    for f in /site/*/index.html; do \
      grep -q 'bridge/loader.js' "$f" || \
      sed -i 's#</body>#<script src="/bridge/config.js"></script><script src="/bridge/adapters.js"></script><script src="/bridge/loader.js" defer></script></body>#' "$f"; \
    done

# Precompress the heavy payloads once at build time; nginx serves the .gz
# copies via gzip_static instead of compressing on every request.
RUN find /site -type f \( -name '*.wasm' -o -name '*.js' -o -name '*.html' \) \
      -exec sh -c 'gzip -9 -c "$1" > "$1.gz"' _ {} \;

# ---- Stage 2: nginx serving the six apps + portal ----
FROM nginx:1.27-alpine

# Port nginx listens on, plus the relay proxy's upstream (host:port on
# Railway private networking — the platform injects PORT=8080 into the relay
# container) and the DNS resolver used to re-resolve it per request.
ENV PORT=8080
ARG RELAY_UPSTREAM="craft-relay.railway.internal:8080"
ENV RELAY_UPSTREAM=${RELAY_UPSTREAM}
ARG RESOLVER="[fd12::10]"
ENV RESOLVER=${RESOLVER}

COPY nginx/templates/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=fetch /site /usr/share/nginx/html
COPY portal/ /usr/share/nginx/html/

EXPOSE 8080
