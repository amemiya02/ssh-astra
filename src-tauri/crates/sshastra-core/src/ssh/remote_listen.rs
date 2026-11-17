//! Ports the server listens on for us (`tcpip-forward`, as for `ssh -R`).
//! Every connection the server accepts there arrives as a `forwarded-tcpip`
//! channel in the client Handler, which routes it by port to the
//! [`RemoteListener`] that asked for it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use russh::client::Msg;
use russh::ChannelStream;
use tokio::sync::mpsc;

use super::Connection;

/// Where the `forwarded-tcpip` channels for each port the server listens on
/// go. Shared by a Connection and its Handler.
#[derive(Clone, Default)]
pub(super) struct Routes(Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<ChannelStream<Msg>>>>>);

impl Routes {
    fn lock(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<u32, mpsc::UnboundedSender<ChannelStream<Msg>>>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Where a channel the server opened for `port` goes, if anyone listens.
    pub(super) fn route(&self, port: u32) -> Option<mpsc::UnboundedSender<ChannelStream<Msg>>> {
        self.lock().get(&port).filter(|tx| !tx.is_closed()).cloned()
    }
}

/// A port the server listens on for this Connection. Dropping it asks the
/// server to stop listening; it keeps its Connection open until then.
pub(crate) struct RemoteListener {
    connection: Arc<Connection>,
    address: String,
    port: u32,
    incoming: mpsc::UnboundedReceiver<ChannelStream<Msg>>,
}

impl RemoteListener {
    /// The next connection the server accepted on the port; `None` once the
    /// Connection is gone.
    pub(crate) async fn accept(&mut self) -> Option<ChannelStream<Msg>> {
        self.incoming.recv().await
    }

    pub(crate) fn connection(&self) -> &Arc<Connection> {
        &self.connection
    }
}

impl Drop for RemoteListener {
    fn drop(&mut self) {
        self.connection.routes.lock().remove(&self.port);
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let connection = Arc::clone(&self.connection);
        let (address, port) = (std::mem::take(&mut self.address), self.port);
        runtime.spawn(async move {
            let _ = connection.handle.cancel_tcpip_forward(address, port).await;
        });
    }
}

impl Connection {
    /// Asks the server to listen on `address:port` and hand every connection
    /// it accepts there to the returned listener (`tcpip-forward`).
    /// `russh::Error::RequestDenied` if the server refuses (port taken, not
    /// allowed, ...).
    pub(crate) async fn listen_remote(
        self: &Arc<Self>,
        address: &str,
        port: u16,
    ) -> Result<RemoteListener, russh::Error> {
        let granted = self.handle.tcpip_forward(address, u32::from(port)).await?;
        // Port 0 lets the server choose; it then says which.
        let port = if port == 0 { granted } else { u32::from(port) };
        let (tx, incoming) = mpsc::unbounded_channel();
        self.routes.lock().insert(port, tx);
        Ok(RemoteListener {
            connection: Arc::clone(self),
            address: address.to_owned(),
            port,
            incoming,
        })
    }
}
