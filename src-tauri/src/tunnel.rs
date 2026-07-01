//! TCP port forwarding over SSH.
//!
//! * Local (-L): a local `127.0.0.1:port` listener; each accepted connection
//!   opens a direct-tcpip channel to `dest_host:dest_port` (reachable from the
//!   SSH server) and pipes bytes.
//! * Dynamic (-D): a local SOCKS5 proxy; each CONNECT request opens a
//!   direct-tcpip channel to the requested destination.
//!
//! Both are client-initiated (no changes to the connection Handler needed).

use std::sync::Arc;

use russh::client::Handle;
use serde::Serialize;
use tokio::io::{copy_bidirectional, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::ssh::ClientHandler;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub id: String,
    pub connection_id: String,
    /// "local" or "dynamic".
    pub kind: String,
    pub bind_port: u16,
    /// Target host (local forward only; empty for dynamic).
    pub dest_host: String,
    /// Target port (local forward only; 0 for dynamic).
    pub dest_port: u16,
}

/// A running tunnel: the accept-loop task plus the SSH handles kept alive.
pub struct Tunnel {
    pub info: TunnelInfo,
    task: tokio::task::JoinHandle<()>,
    _handle: Arc<Handle<ClientHandler>>,
    _jump: Vec<Handle<ClientHandler>>,
}

impl Tunnel {
    pub(crate) fn new(
        info: TunnelInfo,
        task: tokio::task::JoinHandle<()>,
        handle: Arc<Handle<ClientHandler>>,
        jump: Vec<Handle<ClientHandler>>,
    ) -> Self {
        Tunnel { info, task, _handle: handle, _jump: jump }
    }

    /// Stop accepting new connections. Existing piped connections finish on
    /// their own; the SSH connection closes when this Tunnel is dropped.
    pub fn abort(&self) {
        self.task.abort();
    }
}

/// Local forward: accept on `listener`, tunnel each connection to dest.
pub(crate) async fn run_local_listener(
    listener: TcpListener,
    handle: Arc<Handle<ClientHandler>>,
    dest_host: String,
    dest_port: u16,
) {
    loop {
        let (mut tcp, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(_) => break,
        };
        let h = handle.clone();
        let dest = dest_host.clone();
        tokio::spawn(async move {
            let origin = peer.ip().to_string();
            if let Ok(channel) = h
                .channel_open_direct_tcpip(dest, dest_port as u32, origin, peer.port() as u32)
                .await
            {
                let mut stream = channel.into_stream();
                let _ = copy_bidirectional(&mut tcp, &mut stream).await;
            }
        });
    }
}

/// Dynamic (SOCKS5) forward: run a minimal RFC 1928 CONNECT proxy.
pub(crate) async fn run_dynamic_listener(listener: TcpListener, handle: Arc<Handle<ClientHandler>>) {
    loop {
        let (client, _) = match listener.accept().await {
            Ok(x) => x,
            Err(_) => break,
        };
        let h = handle.clone();
        tokio::spawn(async move {
            let _ = socks_connect(h, client).await;
        });
    }
}

async fn socks_connect(handle: Arc<Handle<ClientHandler>>, mut c: TcpStream) -> std::io::Result<()> {
    // Greeting: VER, NMETHODS, METHODS…
    let mut hdr = [0u8; 2];
    c.read_exact(&mut hdr).await?;
    if hdr[0] != 0x05 {
        return Ok(());
    }
    let mut methods = vec![0u8; hdr[1] as usize];
    c.read_exact(&mut methods).await?;
    c.write_all(&[0x05, 0x00]).await?; // choose "no auth"

    // Request: VER CMD RSV ATYP DST.ADDR DST.PORT
    let mut req = [0u8; 4];
    c.read_exact(&mut req).await?;
    if req[1] != 0x01 {
        // only CONNECT is supported
        c.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
        return Ok(());
    }
    let host = match req[3] {
        0x01 => {
            let mut a = [0u8; 4];
            c.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            c.read_exact(&mut len).await?;
            let mut d = vec![0u8; len[0] as usize];
            c.read_exact(&mut d).await?;
            String::from_utf8_lossy(&d).into_owned()
        }
        0x04 => {
            let mut a = [0u8; 16];
            c.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => {
            c.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
            return Ok(());
        }
    };
    let mut port_bytes = [0u8; 2];
    c.read_exact(&mut port_bytes).await?;
    let port = u16::from_be_bytes(port_bytes) as u32;

    match handle
        .channel_open_direct_tcpip(host, port, "127.0.0.1".to_string(), 0u32)
        .await
    {
        Ok(channel) => {
            // reply: success, BND.ADDR/PORT zeroed (accepted by common clients)
            c.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
            let mut stream = channel.into_stream();
            let _ = copy_bidirectional(&mut c, &mut stream).await;
        }
        Err(_) => {
            c.write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?; // refused
        }
    }
    Ok(())
}
