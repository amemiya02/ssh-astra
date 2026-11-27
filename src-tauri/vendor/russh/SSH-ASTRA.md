# russh in SSH Astra

This directory contains the published `russh` 0.65.2 crate from crates.io. The archive SHA-256 is `78229f06e4d96d83bea5f5133ad3b6e4b5f0ce22d8e31c1ff7243ec8e18d5ba1`. `LICENSE.txt` and `rustfmt.toml` come from [the release's upstream source revision](https://github.com/Eugeny/russh/tree/56a999871aa134072e4f2a7395fe2de313870e21).

SSH Astra observes the automatic client keepalive to display latency without sending another request. The local patch timestamps the request as it leaves the client packet queue and reports its round-trip time when the FIFO entry receives either SSH reply. It touches `src/client/{mod,session,encrypted}.rs`, `src/session.rs`, and the matching arms in `src/server/encrypted.rs`. For an update, use an upstream observation API if available, or reapply the patch to the new published crate and rerun the ConnectionManager keepalive and reconnect tests.
