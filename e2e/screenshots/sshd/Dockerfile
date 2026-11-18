# OpenSSH server for the README screenshots (`pnpm screenshots`): a demo
# user with a colour prompt, htop and a fictional project in git. Not used by
# the tests; see e2e/screenshots/docker-compose.yml.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server git htop iproute2 procps less \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && rm -f /etc/motd /etc/update-motd.d/*

# Key login only for `deploy` (the screenshot run installs its public key at
# start-up), with the stock Debian .bashrc's colour prompt switched on.
# (`usermod -p '*'`: no password, but not locked, which sshd would refuse.)
RUN useradd -m -s /bin/bash deploy && usermod -p '*' deploy \
 && sed -i 's/^#force_color_prompt=yes/force_color_prompt=yes/' /home/deploy/.bashrc \
 && install -d -o deploy -g deploy -m 700 /home/deploy/.ssh

COPY --chown=deploy:deploy --chmod=755 demo-home.sh /tmp/demo-home.sh
RUN su deploy -c /tmp/demo-home.sh && rm /tmp/demo-home.sh

COPY sshd_config /etc/ssh/sshd_config
COPY --chmod=755 entrypoint.sh /entrypoint.sh

EXPOSE 22
HEALTHCHECK --interval=1s --timeout=2s --retries=30 \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/22'
ENTRYPOINT ["/entrypoint.sh"]
