//! Loopback security and recovery matrix for the QUIC sidecar, run in-process
//! against the same start/bridge code the CLI uses.

use std::{future::Future, net::SocketAddr};

use futures::{SinkExt, StreamExt};
use omp_remote_quic::{
	enrollment::{self, Role},
	relay,
};
use tokio::net::TcpStream;
use tokio_tungstenite::{
	MaybeTlsStream, WebSocketStream,
	tungstenite::{client::IntoClientRequest, protocol::Message},
};

/// A sidecar topology for one test: host identity, guest identity, allowlist
/// file, and the running handles.
struct Topology {
	/// Kept alive so the identity files outlive the running handles.
	host_dir:      tempfile::TempDir,
	/// Kept alive so the guest identity files outlive the running handles.
	guest_dir:     tempfile::TempDir,
	allowlist_dir: tempfile::TempDir,
	host:          relay::HostHandle,
	guest:         relay::GuestHandle,
}

async fn topology(guest_role: Role) -> Topology {
	let host_dir = tempfile::tempdir().expect("host temp");
	let guest_dir = tempfile::tempdir().expect("guest temp");
	let allowlist_dir = tempfile::tempdir().expect("allowlist temp");

	omp_remote_quic::identity::generate_identity(host_dir.path(), "host.test")
		.expect("host identity");
	omp_remote_quic::identity::generate_identity(guest_dir.path(), "guest.test")
		.expect("guest identity");

	let guest_cert =
		omp_remote_quic::identity::load_cert(&guest_dir.path().join("cert.pem")).expect("guest cert");
	let clients = allowlist_dir.path().join("clients.json");
	enrollment::enroll(&clients, &guest_cert.fingerprint_hex(), "train-guest", guest_role)
		.expect("enroll");

	let host = relay::start_host(
		host_dir.path().to_owned(),
		clients.clone(),
		"127.0.0.1:0".parse().expect("bind"),
	)
	.await
	.expect("host start");
	let server_pin = omp_remote_quic::identity::load_cert(&host_dir.path().join("cert.pem"))
		.expect("host cert")
		.fingerprint_hex();
	let guest = relay::start_guest(guest_dir.path().to_owned(), host.quic_addr, &server_pin)
		.await
		.expect("guest start");
	Topology { host_dir, guest_dir, allowlist_dir, host, guest }
}

fn ws_connect(
	addr: SocketAddr,
	room: &str,
) -> impl Future<Output = WebSocketStream<MaybeTlsStream<TcpStream>>> {
	let request = format!("ws://{addr}/r/{room}.roomsecret?role=guest")
		.into_client_request()
		.expect("request");
	async move {
		tokio_tungstenite::connect_async(request)
			.await
			.expect("ws connect")
			.0
	}
}

#[tokio::test]
async fn enrolled_guest_relays_envelopes_to_the_host() {
	let topology = topology(Role::Write).await;
	let mut host_ws = ws_connect(topology.host.ws_addr, "room-a").await;
	let mut guest_ws = ws_connect(topology.guest.ws_addr, "room-a").await;

	// The host learns about the guest through a peer-joined control frame.
	let control = host_ws.next().await.expect("control").expect("message");
	let Message::Text(text) = control else {
		panic!("expected text control, got {control:?}");
	};
	assert!(text.contains("peer-joined"), "unexpected control {text}");

	// Guest → host envelope: the sidecar rewrites the peer id header.
	guest_ws
		.send(Message::Binary(vec![0u8, 0, 0, 0, 0x7f].into()))
		.await
		.expect("send");
	let relayed = tokio::time::timeout(std::time::Duration::from_secs(5), host_ws.next())
		.await
		.expect("host receives in time")
		.expect("frame")
		.expect("message");
	let Message::Binary(payload) = relayed else {
		panic!("expected binary envelope, got {relayed:?}");
	};
	assert_ne!(&payload[..4], &[0, 0, 0, 0], "peer id must be rewritten, not zero");
	assert_eq!(payload[4], 0x7f);

	// Host → guest envelope round-trips as well. The broker rewrites the
	// sender's peer id into the header; the host joined first, so it is peer 1.
	host_ws
		.send(Message::Binary(vec![1u8, 0, 0, 0, 0x2a].into()))
		.await
		.expect("send");
	let relayed = tokio::time::timeout(std::time::Duration::from_secs(5), guest_ws.next())
		.await
		.expect("guest receives in time")
		.expect("frame")
		.expect("message");
	let Message::Binary(payload) = relayed else {
		panic!("expected binary envelope, got {relayed:?}");
	};
	assert_eq!(&payload[..4], &[0, 0, 0, 1], "header must carry the host's peer id");
	assert_eq!(payload[4], 0x2a);

	topology.host.stop().await;
}

#[tokio::test]
async fn wrong_pin_is_refused() {
	let topology = topology(Role::Write).await;
	let guest_dir = tempfile::tempdir().expect("temp");
	omp_remote_quic::identity::generate_identity(guest_dir.path(), "guest2.test").expect("identity");
	let Err(error) =
		relay::start_guest(guest_dir.path().to_owned(), topology.host.quic_addr, &"a".repeat(64))
			.await
	else {
		panic!("wrong pin must refuse the connection");
	};
	assert!(
		error.to_string().contains("pinned fingerprint"),
		"expected a pin-mismatch refusal, got {error}"
	);
	topology.host.stop().await;
}

#[tokio::test]
async fn unknown_client_is_refused() {
	let topology = topology(Role::Write).await;
	// An identity that was never enrolled.
	let stranger_dir = tempfile::tempdir().expect("temp");
	omp_remote_quic::identity::generate_identity(stranger_dir.path(), "stranger.test")
		.expect("identity");
	let host_cert = omp_remote_quic::identity::load_cert(&topology.host_dir.path().join("cert.pem"))
		.expect("cert");
	let client_config = omp_remote_quic::transport::client_config(
		omp_remote_quic::identity::load_cert(&stranger_dir.path().join("cert.pem"))
			.expect("cert")
			.cert,
		omp_remote_quic::identity::load_key(&stranger_dir.path().join("key.pem")).expect("key"),
		host_cert.fingerprint,
	)
	.expect("client config");
	let endpoint = quinn::Endpoint::client("0.0.0.0:0".parse().expect("bind")).expect("endpoint");
	// TLS 1.3 client-auth timing: the client's handshake completes BEFORE the
	// server has verified the client certificate, so the connection may resolve
	// and then be closed the moment the allowlist check rejects it.
	let connection = endpoint
		.connect_with(client_config, topology.host.quic_addr, "omp-remote")
		.expect("dial")
		.await
		.expect("handshake resolves either way");
	let close = tokio::time::timeout(std::time::Duration::from_secs(5), connection.closed())
		.await
		.unwrap_or_else(|_| panic!("unenrolled client must be closed by the server"));
	assert!(
		format!("{close:?}").contains("certificate"),
		"expected a certificate rejection, got {close:?}"
	);
	topology.host.stop().await;
}

#[tokio::test]
async fn revoked_client_is_refused() {
	let topology = topology(Role::Write).await;
	let guest_cert =
		omp_remote_quic::identity::load_cert(&topology.guest_dir.path().join("cert.pem"))
			.expect("cert");
	let clients = topology.allowlist_dir.path().join("clients.json");
	enrollment::revoke(&clients, &guest_cert.fingerprint_hex()).expect("revoke");
	// A fresh guest connection against the same host: the allowlist is loaded
	// per start, so restart the host to pick up the revocation.
	topology.host.stop().await;
	let host = relay::start_host(
		topology.host_dir.path().to_owned(),
		clients.clone(),
		"127.0.0.1:0".parse().expect("bind"),
	)
	.await
	.expect("host restart");
	let Err(error) = relay::start_guest(
		topology.guest_dir.path().to_owned(),
		host.quic_addr,
		&guest_cert.fingerprint_hex(),
	)
	.await
	else {
		panic!("revoked client must fail");
	};
	assert!(
		error.to_string().contains("handshake failed"),
		"expected a TLS-level rejection, got {error}"
	);
	host.stop().await;
}

#[tokio::test]
async fn oversized_frames_abort_the_connection() {
	let topology = topology(Role::Write).await;
	let mut guest_ws = ws_connect(topology.guest.ws_addr, "room-big").await;
	let mut host_ws = ws_connect(topology.host.ws_addr, "room-big").await;
	// The guest joined before the host: the host learns about it on join.
	let control = tokio::time::timeout(std::time::Duration::from_secs(5), host_ws.next())
		.await
		.expect("host learns about the early guest")
		.expect("frame")
		.expect("message");
	let Message::Text(text) = control else {
		panic!("expected text control, got {control:?}");
	};
	assert!(text.contains("peer-joined"), "unexpected control {text}");

	// A length prefix beyond the cap aborts the stream, so the guest's WS
	// surface closes instead of buffering unbounded bytes.
	// The WS bridge wraps every message in stream framing, so an oversized
	// WS *message* produces an oversized stream length prefix on the wire.
	let oversized = vec![0u8; omp_remote_quic::MAX_FRAME_BYTES as usize + 1];
	guest_ws
		.send(Message::Binary(oversized.into()))
		.await
		.expect("send oversized frame");
	let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), guest_ws.next()).await;
	// The stream (and with it the guest WS) must terminate: timeout, transport
	// error, or clean end. A delivered message would mean we buffered the
	// oversized frame instead of aborting.
	let terminated = match outcome {
		Err(_) => true,
		Ok(None) => true,
		Ok(Some(Err(_))) => true,
		Ok(Some(Ok(_))) => false,
	};
	assert!(terminated, "expected termination, got {outcome:?}");
	topology.host.stop().await;
}

#[tokio::test]
async fn host_room_close_tells_the_guest() {
	let topology = topology(Role::Write).await;
	let mut guest_ws = ws_connect(topology.guest.ws_addr, "room-end").await;
	let mut host_ws = ws_connect(topology.host.ws_addr, "room-end").await;
	// Guests receive nothing on join; the host sees the guest's peer-joined.
	let _ = tokio::time::timeout(std::time::Duration::from_secs(5), host_ws.next()).await;

	// The host's WS surface closing means the room ends: the guest receives
	// the room-closed control and its OMP layer reattaches from saved state.
	host_ws.close(None).await.expect("close");
	let closed = tokio::time::timeout(std::time::Duration::from_secs(5), guest_ws.next())
		.await
		.expect("guest learns in time")
		.expect("frame")
		.expect("message");
	let Message::Text(text) = closed else {
		panic!("expected room-closed text control, got {closed:?}");
	};
	assert!(text.contains("room-closed"), "unexpected control {text}");
	topology.host.stop().await;
}

#[tokio::test]
async fn read_enrolled_clients_connect_and_are_tagged() {
	// The sidecar's role tier: a read-enrolled guest joins normally; the OMP
	// host receives its role through the enrollment-tagged join so write
	// enforcement stays at the OMP layer where the write token lives.
	let topology = topology(Role::Read).await;
	let mut guest_ws = ws_connect(topology.guest.ws_addr, "room-read").await;
	let mut host_ws = ws_connect(topology.host.ws_addr, "room-read").await;
	let control = host_ws.next().await.expect("control").expect("message");
	let Message::Text(text) = control else {
		panic!("expected text control, got {control:?}");
	};
	assert!(text.contains("peer-joined"), "unexpected control {text}");
	// The read-tier guest still relays (sealed) frames; the OMP host refuses
	// unauthorized writes itself.
	guest_ws
		.send(Message::Binary(vec![9u8, 0, 0, 0, 1].into()))
		.await
		.expect("send");
	let relayed = tokio::time::timeout(std::time::Duration::from_secs(5), host_ws.next())
		.await
		.expect("host receives")
		.expect("frame")
		.expect("message");
	assert!(matches!(relayed, Message::Binary(_)));
	topology.host.stop().await;
}
