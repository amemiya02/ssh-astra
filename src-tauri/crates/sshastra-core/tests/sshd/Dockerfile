# OpenSSH server for sshastra's integration tests. Test-only: the host key
# and passwords in this directory are public fixtures, never use them anywhere
# else.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server socat \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && rm -f /etc/ssh/ssh_host_*

# Password login: tester / testpass.
RUN useradd -m -s /bin/bash tester && echo 'tester:testpass' | chpasswd

# Key login for tester with the public keys of the fixtures in keys/ (all
# test-only; id_ed25519_unauthorized is deliberately left out).
COPY --chown=tester:tester --chmod=600 keys/authorized_keys /home/tester/.ssh/authorized_keys
RUN chmod 700 /home/tester/.ssh

# A fixed tree for the File panel (SftpFs) tests, owned by root: tester can
# read it but not `locked/`. `many/` holds 10,000 empty files.
RUN mkdir -p /srv/files/docs /srv/files/locked /srv/files/many \
 && printf 'hello\n' > /srv/files/hello.txt \
 && printf 'x' > /srv/files/.hidden \
 && ln -s docs /srv/files/docs-link \
 && ln -s missing /srv/files/dangling \
 && chmod 640 /srv/files/hello.txt \
 && chmod 700 /srv/files/locked \
 && touch -d '2024-01-02T03:04:05Z' /srv/files/hello.txt \
 && cd /srv/files/many && seq -f 'f%05g' 1 10000 | xargs touch

COPY sshd_config /etc/ssh/sshd_config
# A fixed host key, so tests know the fingerprint the server will present.
COPY ssh_host_ed25519_key ssh_host_ed25519_key.pub /etc/ssh/
RUN chmod 600 /etc/ssh/ssh_host_ed25519_key

EXPOSE 22
HEALTHCHECK --interval=1s --timeout=2s --retries=30 \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/22'
CMD ["/usr/sbin/sshd", "-D", "-e"]
