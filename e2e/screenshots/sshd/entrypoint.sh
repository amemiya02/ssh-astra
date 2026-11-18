#!/bin/bash
# Each container gets host keys of its own, then (with $THROTTLE, e.g. 32mbit)
# a capped outgoing rate on every interface, so a screenshot can catch file
# transfers mid-way. Throttling needs the NET_ADMIN capability.
set -e
ssh-keygen -A >/dev/null
if [ -n "${THROTTLE:-}" ]; then
  for dev in /sys/class/net/eth*; do
    tc qdisc replace dev "$(basename "$dev")" root tbf rate "$THROTTLE" burst 64kb latency 400ms
  done
fi
exec /usr/sbin/sshd -D -e
