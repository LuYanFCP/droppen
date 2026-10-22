#!/usr/bin/env bash
# Build the Linux server binaries (x86_64 and aarch64, glibc >= 2.28) in one
# throwaway Kubernetes pod, for scripts/release-public.sh.
#
#   scripts/build-linux.sh <src-dir> <out-dir> <rev>
#
#   <src-dir>  a source tree with web/dist already built (the web app is
#              embedded at compile time), e.g. release-public.sh's export
#   <out-dir>  receives x86_64/remote-hand-server, aarch64/remote-hand-server
#              and build.log
#   <rev>      the short commit, passed to the build as DROPPEN_BUILD_REV (and
#              as RH_BUILD_REV, for a commit from before the rename to Droppen)
#
# How: rust:1.98.1-bookworm (pinned by digest) with zig and cargo-zigbuild,
# both pinned (zig's tarball checked against its sha256). cargo-zigbuild links against glibc 2.28
# for both targets from one x86_64 node: one toolchain for the C in aws-lc-sys,
# ring and SQLite, and binaries that run on Debian 10, Ubuntu 20.04, RHEL 8 and
# anything newer. The source goes in with tar over `kubectl exec` (tracked files
# and web/dist, no .git, no credentials); the binaries come back the same way;
# the pod is deleted by name whatever happens.
#
# Environment (the cluster is the operator's; nothing here defaults to one):
#   DROPPEN_K8S_CONTEXT         kubectl context to create the pod in (required)
#   DROPPEN_K8S_NAMESPACE       namespace (required)
#   DROPPEN_K8S_PRIORITY_CLASS  the pod's priorityClassName (optional)
set -euo pipefail

SRC=${1:?usage: build-linux.sh <src-dir> <out-dir> <rev>}
OUT=${2:?usage: build-linux.sh <src-dir> <out-dir> <rev>}
REV=${3:?usage: build-linux.sh <src-dir> <out-dir> <rev>}
CONTEXT=${DROPPEN_K8S_CONTEXT:-}
NAMESPACE=${DROPPEN_K8S_NAMESPACE:-}
PRIORITY=${DROPPEN_K8S_PRIORITY_CLASS:-}
[ -n "$CONTEXT" ] && [ -n "$NAMESPACE" ] || {
  echo "build-linux: set DROPPEN_K8S_CONTEXT and DROPPEN_K8S_NAMESPACE to the cluster and namespace to build in (and DROPPEN_K8S_PRIORITY_CLASS if it needs one)" >&2
  exit 2
}
IMAGE=rust:1.98.1-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e
ZIG_VERSION=0.13.0
ZIG_SHA256=d45312e61ebcc48032b77bc4cf7fd6915c11fa16e4aad116b66c9468211230ea
ZIGBUILD_VERSION=0.23.4
GLIBC=2.28
K=(kubectl --context "$CONTEXT" -n "$NAMESPACE")

[ -f "$SRC/web/dist/index.html" ] || { echo "build-linux: $SRC/web/dist is missing; build the web app first" >&2; exit 2; }
command -v kubectl >/dev/null || { echo "build-linux: needs kubectl" >&2; exit 2; }
mkdir -p "$OUT"

run_id="$(date +%m%d%H%M%S)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')"
POD="droppen-build-linux-${run_id}"
created=0
cleanup() {
  local rc=$?
  if [ "$created" = 1 ]; then
    echo "build-linux: deleting pod $POD"
    "${K[@]}" delete pod "$POD" --ignore-not-found --wait=false >/dev/null || true
    "${K[@]}" wait --for=delete "pod/$POD" --timeout=180s >/dev/null 2>&1 \
      || echo "build-linux: WARNING: pod $POD still present; delete it by name" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

# Marked before the create, so a create that fails half way is still deleted
# (by name, --ignore-not-found).
created=1
cat <<YAML | "${K[@]}" create -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: $POD
  labels:
    app: droppen-build
    droppen-build/run: "$run_id"
  annotations:
    droppen-build/purpose: "linux release binaries, $REV"
spec:
  restartPolicy: Never
$([ -z "$PRIORITY" ] || printf '  priorityClassName: %s\n' "$PRIORITY")
  automountServiceAccountToken: false
  enableServiceLinks: false
  terminationGracePeriodSeconds: 5
  activeDeadlineSeconds: 7200
  volumes:
    - name: work
      emptyDir:
        sizeLimit: 40Gi
  containers:
    - name: build
      image: $IMAGE
      command: [sleep, "7200"]
      resources:
        requests: {cpu: "8", memory: 16Gi, ephemeral-storage: 20Gi}
        limits: {cpu: "16", memory: 32Gi, ephemeral-storage: 45Gi}
      volumeMounts:
        - {name: work, mountPath: /work}
YAML
echo "build-linux: pod $POD created in $CONTEXT/$NAMESPACE; waiting for it"
"${K[@]}" wait --for=condition=Ready "pod/$POD" --timeout=20m >/dev/null
x() { "${K[@]}" exec -i "$POD" -c build -- "$@"; }

x mkdir -p /work/src /work/out
# Everything but build outputs and dependencies: the pod builds those itself.
tar -C "$SRC" -cf - --exclude ./node_modules --exclude ./web/node_modules --exclude ./server-rs/target \
  --exclude ./packages/plugin-sdk/node_modules . | x tar -x -C /work/src
echo "build-linux: source uploaded; building"

x env DROPPEN_BUILD_REV="$REV" RH_BUILD_REV="$REV" ZIG_VERSION="$ZIG_VERSION" ZIG_SHA256="$ZIG_SHA256" \
  ZIGBUILD_VERSION="$ZIGBUILD_VERSION" GLIBC="$GLIBC" bash -s <<'SH' 2>&1 | tee "$OUT/build.log"
set -euo pipefail
cd /tmp
curl -fsSL -o zig.tar.xz "https://ziglang.org/download/${ZIG_VERSION}/zig-linux-x86_64-${ZIG_VERSION}.tar.xz"
echo "${ZIG_SHA256}  zig.tar.xz" | sha256sum -c -
tar -xJf zig.tar.xz -C /opt
export PATH="/opt/zig-linux-x86_64-${ZIG_VERSION}:$PATH"
zig version
export CARGO_TARGET_DIR=/work/target
cargo install --locked --quiet cargo-zigbuild --version "${ZIGBUILD_VERSION}"
rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu
cd /work/src/server-rs
for arch in x86_64 aarch64; do
  echo "== ${arch}-unknown-linux-gnu.${GLIBC}"
  RUSTFLAGS="--remap-path-prefix=/work/src=/droppen --remap-path-prefix=${CARGO_HOME:-/usr/local/cargo}=/cargo" \
    cargo zigbuild --release --locked --target "${arch}-unknown-linux-gnu.${GLIBC}" -p remote-hand-server
  mkdir -p "/work/out/${arch}"
  cp "/work/target/${arch}-unknown-linux-gnu/release/remote-hand-server" "/work/out/${arch}/"
done
ls -l /work/out/*
SH

x tar -C /work/out -cf - x86_64 aarch64 | tar -x -C "$OUT"
ls -l "$OUT"/x86_64/remote-hand-server "$OUT"/aarch64/remote-hand-server
echo "build-linux: done"
