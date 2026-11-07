#!/usr/bin/env bash
# Once per Apple-silicon Mac whose Docker VM runs amd64 through Rosetta (Rancher Desktop with Rosetta, Docker Desktop
# with "Use Rosetta"): a buildx builder that builds the linux/amd64 image through Rosetta, not QEMU.
#
# BuildKit decides which platforms run natively by executing a tiny test binary per architecture. Rosetta refuses
# the amd64 one, so BuildKit routes every amd64 step through the QEMU it bundles, where `next build` hangs. This
# builder's image leaves that QEMU out: BuildKit then executes amd64 steps directly, and the VM's kernel hands them
# to Rosetta, as it does for `docker run --platform linux/amd64`.
#
#   scripts/rosetta-builder.sh          then deploy with BUILDX_BUILDER=a6g-rosetta (sst.config.ts reads it)
set -euo pipefail
BUILDKIT=v0.33.1
NAME=a6g-rosetta
IMAGE="a6g-buildkit-rosetta:$BUILDKIT"

printf 'FROM moby/buildkit:%s\nRUN rm /usr/bin/buildkit-qemu-x86_64\n' "$BUILDKIT" | docker build -q -t "$IMAGE" -
docker buildx rm "$NAME" >/dev/null 2>&1 || true
docker buildx create --name "$NAME" --driver docker-container --driver-opt "image=$IMAGE" --bootstrap >/dev/null
echo "builder $NAME ready: deploy with BUILDX_BUILDER=$NAME"
