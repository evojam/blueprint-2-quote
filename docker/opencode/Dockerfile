# OpenCode is pre-installed in the base image (docker/opencode/Dockerfile.base,
# built and pushed to a registry — see BASE_IMAGE.md). This image only layers in
# the project's agents, skills, and entrypoint, so app/dev builds need NO network
# and cannot hit the OpenCode-installer TLS-proxy failures. Rebuilds are seconds.
#
# Set OPENCODE_BASE_IMAGE to your pushed base tag. The default is a placeholder
# on purpose: it fails loudly if left unset rather than silently pulling the
# wrong image. Override per build with `--build-arg OPENCODE_BASE_IMAGE=...` or
# set the default below to your registry namespace.
ARG OPENCODE_BASE_IMAGE=docker.io/openmercatocom/open-mercato-opencode:1.18.3
FROM ${OPENCODE_BASE_IMAGE}

# The base image already installed OpenCode, created the non-root `opencode`
# user + /home/opencode/.config/opencode, and set WORKDIR. Re-assert them so
# this Dockerfile is readable on its own and safe if the base ever changes.
#
# Renumber `opencode` (uid/gid 1000 in the base image) onto the app image's
# `omuser` (uid/gid 1001, main `Dockerfile`). The `opencode_work` volume is
# mounted at /home/opencode/work in `app`, `mcp` AND `opencode`; with two
# different uids on it, whichever container writes first locks the other out.
# Override both args together if the app's uid ever moves.
#
# `work/` is created here on purpose: a named/task volume inherits its owner
# from the image directory it is first mounted over, and the base image has no
# such directory — so a fresh volume came up root-owned 0755 and nobody but
# root could write it. Seeded 1001:1001, opencode and the app agree on it.
ARG OPENCODE_UID=1001
ARG OPENCODE_GID=1001
USER root
RUN groupmod -g "${OPENCODE_GID}" opencode \
 && usermod -u "${OPENCODE_UID}" -g "${OPENCODE_GID}" opencode \
 && chown -R "${OPENCODE_UID}:${OPENCODE_GID}" /home/opencode \
 && install -d -o "${OPENCODE_UID}" -g "${OPENCODE_GID}" /home/opencode/work

USER opencode
WORKDIR /home/opencode

# Copy instructions to working directory (OpenCode resolves relative to $CWD)
COPY --chown=opencode:opencode AGENTS.md /home/opencode/AGENTS.md
COPY --chown=opencode:opencode entrypoint.sh /home/opencode/entrypoint.sh

# Bake the generated, file-defined OpenCode agents into the image (prod delivery
# model B). Dev bind-mounts this same dir via docker-compose.*.dev.yml (model A).
COPY --chown=opencode:opencode agents/ /home/opencode/.config/opencode/agents/

# Bake the generated NATIVE OpenCode skill files into the image. Dev bind-mounts
# the same dir. OpenCode lists each skill in the built-in `skill` tool and pulls
# SKILL.md on demand (progressive disclosure).
COPY --chown=opencode:opencode skills/ /home/opencode/.config/opencode/skills/

USER root
RUN chmod +x /home/opencode/entrypoint.sh
USER opencode

EXPOSE 4096

# Use entrypoint to generate config dynamically
ENTRYPOINT ["/home/opencode/entrypoint.sh"]
