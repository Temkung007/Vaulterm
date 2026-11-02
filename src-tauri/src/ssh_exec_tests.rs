//! Exercise the real SSH channel without external servers or saved credentials.

use super::*;
use russh::{server, ChannelId};

struct ExecServer {
    command: String,
    received: Arc<Mutex<Vec<u8>>>,
}

impl server::Handler for ExecServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, _: &str, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _: Channel<server::Msg>,
        _: &mut server::Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.command = String::from_utf8_lossy(data).into_owned();
        session.channel_success(channel)?;
        match self.command.as_str() {
            "streams" => {
                session.data(channel, b"output\n".to_vec())?;
                session.extended_data(channel, 1, b"warning\n".to_vec())?;
                // Servers may send the exit status only after the data EOF.
                session.eof(channel)?;
                session.exit_status_request(channel, 42)?;
                session.close(channel)?;
            }
            "limit" => {
                session.data(channel, b"stdout".to_vec())?;
                session.extended_data(channel, 1, b"stderr".to_vec())?;
                session.eof(channel)?;
                session.exit_status_request(channel, 0)?;
                session.close(channel)?;
            }
            "hang" => session.data(channel, b"partial\n".to_vec())?,
            "reject-input" => {
                session.extended_data(channel, 1, b"cannot open destination\n".to_vec())?;
                session.eof(channel)?;
                session.exit_status_request(channel, 1)?;
                session.close(channel)?;
            }
            "ignore-input" => {
                session.eof(channel)?;
                session.exit_status_request(channel, 0)?;
                session.close(channel)?;
            }
            "stdin" => {}
            other => panic!("unexpected test command: {other}"),
        }
        Ok(())
    }

    async fn data(
        &mut self,
        _: ChannelId,
        data: &[u8],
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if self.command == "stdin" {
            self.received.lock().unwrap().extend_from_slice(data);
        }
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if self.command == "stdin" {
            let count = self.received.lock().unwrap().len();
            session.data(channel, format!("received {count} bytes\n").into_bytes())?;
            session.eof(channel)?;
            session.exit_status_request(channel, 0)?;
            session.close(channel)?;
        }
        Ok(())
    }
}

async fn local_server() -> (Handle<ClientHandler>, Arc<Mutex<Vec<u8>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let received = Arc::new(Mutex::new(Vec::new()));
    let handler = ExecServer {
        command: String::new(),
        received: received.clone(),
    };
    // A deterministic throwaway host key avoids adding an RNG dependency to tests.
    let key = russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[41; 32]);
    let config = Arc::new(server::Config {
        keys: vec![PrivateKey::from(key)],
        // A small window forces large stdin through the SSH flow-control path.
        window_size: 16 * 1024,
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let running = server::run_stream(config, socket, handler).await.unwrap();
        // Keep the handler alive until the test's runtime shuts down.
        let _ = running.await;
    });
    let handler = ClientHandler {
        host: address.ip().to_string(),
        port: address.port(),
        known: Vec::new(),
        trust_override: false,
        outcome: Arc::new(Mutex::new(HostKeyOutcome::Pending)),
        forward_to: None,
        forward_sem: None,
    };
    let mut handle = client::connect(Arc::new(Config::default()), address, handler)
        .await
        .unwrap();
    assert!(handle
        .authenticate_password("test", "unused")
        .await
        .unwrap()
        .success());
    (handle, received)
}

fn output(result: Result<ExecOutput, SshConnectError>) -> ExecOutput {
    match result {
        Ok(result) => result,
        Err(SshConnectError::Other(message)) => panic!("SSH execution failed: {message}"),
        Err(SshConnectError::HostKeyMismatch { .. }) => panic!("unexpected host key mismatch"),
    }
}

#[tokio::test]
async fn exec_reports_both_streams_and_exit_status_after_eof() {
    let (handle, _) = local_server().await;
    let result = output(exec_report(&handle, "streams", None, Duration::from_secs(2), 1024).await);
    assert_eq!(result.stdout, "output\n");
    assert_eq!(result.stderr, "warning\n");
    assert_eq!(result.exit_code, Some(42));
    assert!(!result.timed_out);
    assert!(!result.truncated);
    assert!(result.is_error());
}

#[tokio::test]
async fn exec_applies_one_capture_limit_to_stdout_and_stderr() {
    let (handle, _) = local_server().await;
    let result = output(exec_report(&handle, "limit", None, Duration::from_secs(2), 9).await);
    assert_eq!(result.stdout, "stdout");
    assert_eq!(result.stderr, "std");
    assert!(result.truncated);
    assert!(!result.timed_out);
    assert!(result.is_error());
}

#[tokio::test]
async fn exec_timeout_keeps_partial_output() {
    let (handle, _) = local_server().await;
    let result = output(exec_report(&handle, "hang", None, Duration::from_millis(200), 1024).await);
    assert_eq!(result.stdout, "partial\n");
    assert!(result.timed_out);
    assert!(result.exit_code.is_none());
    assert!(result.is_error());
}

#[tokio::test]
async fn exec_streams_empty_and_one_mib_stdin_exactly_and_sends_eof() {
    for data in [
        Vec::new(),
        (0..1_048_576).map(|i| (i % 251) as u8).collect(),
    ] {
        let (handle, received) = local_server().await;
        let result =
            output(exec_report(&handle, "stdin", Some(&data), Duration::from_secs(5), 1024).await);
        assert_eq!(*received.lock().unwrap(), data);
        assert_eq!(result.stdout, format!("received {} bytes\n", data.len()));
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.is_error());
    }
}

#[tokio::test]
async fn exec_retains_remote_error_when_destination_rejects_large_stdin() {
    let (handle, _) = local_server().await;
    let data = vec![b'x'; 1_048_576];
    let result = output(
        exec_report(
            &handle,
            "reject-input",
            Some(&data),
            Duration::from_secs(2),
            1024,
        )
        .await,
    );
    assert_eq!(result.stderr, "cannot open destination\n");
    assert_eq!(result.exit_code, Some(1));
    assert!(!result.timed_out);
    assert!(result.is_error());
}

#[tokio::test]
async fn exec_does_not_report_success_if_server_closes_before_consuming_stdin() {
    let (handle, _) = local_server().await;
    let data = vec![b'x'; 1_048_576];
    let result = output(
        exec_report(
            &handle,
            "ignore-input",
            Some(&data),
            Duration::from_secs(2),
            1024,
        )
        .await,
    );
    assert_eq!(result.exit_code, Some(0));
    assert!(result.stdin_error.is_some());
    assert!(!result.timed_out);
    assert!(result.is_error());
}
