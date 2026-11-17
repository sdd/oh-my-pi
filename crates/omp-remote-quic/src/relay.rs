//! The room broker: host and guest bridges over QUIC.
//!
//! The sidecar speaks the existing relay contract — `[4B peerId][sealed
//! payload]` binary envelopes plus TEXT control frames — so the OMP
//! processes run unchanged. Two connection classes exist and they are NOT
//! symmetric:
//!
//! - **Host registration** arrives only on the owner-only loopback WebSocket
//!   surface. There is no `role` parameter the remote side could forge: a QUIC
//!   connection is always a guest, regardless of anything it sends.
//! - **Guests** arrive over QUIC with an enrolled, non-revoked client
//!   certificate. Their first framed message names the room; the sidecar forces
//!   `role = guest` and assigns the peer id itself.

use std::{collections::HashMap, net::SocketAddr, path::PathBuf, sync::Arc};

use bytes::{BufMut, Bytes, BytesMut};
use futures::{SinkExt, StreamExt};
use tokio::{
	net::TcpListener,
	sync::{mpsc, oneshot},
};
use tokio_tungstenite::{
	WebSocketStream,
	tungstenite::protocol::{Message, WebSocketConfig},
};

use crate::{
	TransportError, enrollment::Allowlist, framing, identity::EndpointIdentity, transport,
};

/// Backpressure bound per direction of a bridge. A full queue sheds the peer:
/// slow-consumer collapse is reported (the OMP layer resyncs), never buffered
/// unboundedly.
const BRIDGE_BUFFER: usize = 64;

/// Envelope header: 4-byte big-endian peer id.
const PEER_HEADER: usize = 4;

/// WS message cap for the local surfaces; sealed envelopes stay well under it.
const MAX_WS_MESSAGE: usize = 16 * 1024 * 1024;

pub fn quinn_to_relay(error: quinn::ConnectionError) -> RelayError {
	RelayError::Protocol(error.to_string())
}

fn quinn_read_to_relay(error: quinn::ReadError) -> RelayError {
	RelayError::Protocol(error.to_string())
}

fn quinn_write_to_relay(error: quinn::WriteError) -> RelayError {
	RelayError::Protocol(error.to_string())
}

#[derive(Debug, thiserror::Error)]
pub enum RelayError {
	#[error("io: {0}")]
	Io(#[from] std::io::Error),
	#[error("websocket: {0}")]
	WebSocket(#[from] tokio_tungstenite::tungstenite::Error),
	#[error("frame: {0}")]
	Framing(#[from] framing::FrameError),
	#[error("connection closed")]
	Closed,
	#[error("{0}")]
	Protocol(String),
}

/// One framed message over a QUIC stream: a WS-message tag plus payload.
/// Binary payloads are sealed envelopes; text payloads are relay control JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamMessage {
	Binary(Bytes),
	Text(Bytes),
}

/// Encode one tagged stream message. Infallible: the tagged header keeps
/// lengths within `u32` for every payload that passed the frame cap.
fn encode_stream_message(out: &mut BytesMut, message: &StreamMessage) {
	let (tag, payload) = match message {
		StreamMessage::Binary(payload) => (0u8, payload),
		StreamMessage::Text(payload) => (1u8, payload),
	};
	let length = 1 + payload.len();
	out.reserve(4 + length);
	out.extend_from_slice(&(length as u32).to_be_bytes());
	out.put_u8(tag);
	out.extend_from_slice(payload);
}

fn decode_stream_message(
	chunk: &[u8],
	decoder: &mut framing::FrameDecoder,
) -> Result<Vec<StreamMessage>, framing::FrameError> {
	Ok(decoder
		.push(chunk)?
		.into_iter()
		.map(|mut frame| {
			if frame.is_empty() {
				return StreamMessage::Binary(Bytes::new());
			}
			let tag = frame[0];
			let payload = frame.split_off(1);
			if tag == 0 {
				StreamMessage::Binary(payload)
			} else {
				StreamMessage::Text(payload)
			}
		})
		.collect())
}

// ─────────────────────────────────────────────────────────────────────────────
// Room state (host side)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PeerRole {
	Host,
	Guest,
}

/// Commands into the room actor. Peer tasks only ever talk to the actor.
enum RoomCommand {
	Join {
		role:     PeerRole,
		outbound: mpsc::Sender<StreamMessage>,
		ready:    oneshot::Sender<Result<u32, RelayError>>,
	},
	Frame {
		peer:    u32,
		message: StreamMessage,
	},
	Leaving {
		peer: u32,
	},
}

#[derive(Default)]
struct RoomRegistry {
	rooms: tokio::sync::Mutex<HashMap<String, mpsc::UnboundedSender<RoomCommand>>>,
}

struct Peer {
	role:     PeerRole,
	outbound: mpsc::Sender<StreamMessage>,
}

/// The room actor owns peer ids, routing and lifetime. Every peer hands in an
/// outbound lane; inbound frames arrive as [`RoomCommand::Frame`].
async fn run_room(mut commands: mpsc::UnboundedReceiver<RoomCommand>) {
	let mut peers: HashMap<u32, Peer> = HashMap::new();
	let mut next_peer_id: u32 = 1;

	while let Some(command) = commands.recv().await {
		match command {
			RoomCommand::Join { role, outbound, ready } => {
				let peer_id = next_peer_id;
				next_peer_id = next_peer_id.checked_add(1).unwrap_or(1);
				peers.insert(peer_id, Peer { role, outbound });
				let _ = ready.send(Ok(peer_id));
				if role == PeerRole::Host {
					// A host that joins last must learn about every guest that
					// was already waiting: the relay contract announces guest
					// joins to the host, whatever order they arrive in.
					for existing_id in peers
						.iter()
						.filter(|(_, existing)| existing.role == PeerRole::Guest)
						.map(|(id, _)| *id)
					{
						announce_to_host(
							&peers,
							format!(r#"{{"t":"peer-joined","peer":{existing_id}}}"#),
						);
					}
				} else {
					announce_to_host(&peers, format!(r#"{{"t":"peer-joined","peer":{peer_id}}}"#));
				}
			},
			RoomCommand::Frame { peer, message } => {
				// Guests never send control text; only binary envelopes route.
				let StreamMessage::Binary(payload) = message else {
					continue;
				};
				if payload.len() < PEER_HEADER {
					continue;
				}
				// Rewrite the sender's peer id, then fan out to everyone else.
				let mut routed = BytesMut::with_capacity(payload.len());
				routed.extend_from_slice(&peer.to_be_bytes());
				routed.extend_from_slice(&payload[PEER_HEADER..]);
				let routed = routed.freeze();
				for (other_id, other) in &peers {
					if *other_id == peer {
						continue;
					}
					// A full queue sheds that receiver: the OMP layer resyncs
					// from pages, so a dropped frame is recoverable by design.
					let _ = other
						.outbound
						.try_send(StreamMessage::Binary(routed.clone()));
				}
			},
			RoomCommand::Leaving { peer } => {
				let was_host = peers
					.get(&peer)
					.is_some_and(|peer| peer.role == PeerRole::Host);
				peers.remove(&peer);
				if was_host {
					// The host is gone: the room ends. Guests are told once;
					// their OMP layer reattaches from saved state.
					for peer in peers.values() {
						let _ = peer
							.outbound
							.try_send(StreamMessage::Text(Bytes::from_static(br#"{"t":"room-closed"}"#)));
					}
					break;
				}
				announce_to_host(&peers, format!(r#"{{"t":"peer-left","peer":{peer}}}"#));
			},
		}
	}
}

fn announce_to_host(peers: &HashMap<u32, Peer>, control: String) {
	if let Some(host) = peers.values().find(|peer| peer.role == PeerRole::Host) {
		let _ = host
			.outbound
			.try_send(StreamMessage::Text(Bytes::from(control)));
	}
}

/// A running host sidecar: the QUIC endpoint and the local WS surface address.
/// `stop` closes both listeners; the returned future resolves when they exit.
pub struct HostHandle {
	/// QUIC listener address (loopback in tests).
	pub quic_addr: SocketAddr,
	/// Local WebSocket surface for the OMP host process.
	pub ws_addr:   SocketAddr,
	stop:          mpsc::Sender<()>,
}

impl HostHandle {
	pub async fn stop(self) {
		let _ = self.stop.send(()).await;
	}
}

/// Start the host side: local WebSocket surface for the OMP host process
/// (loopback only) and the QUIC listener for enrolled guests.
///
/// Returns a handle for tests and CLI shutdown; the CLI prints the addresses
/// and waits.
pub async fn start_host(
	identity_dir: PathBuf,
	clients_path: PathBuf,
	quic_bind: SocketAddr,
) -> Result<HostHandle, TransportError> {
	let identity = EndpointIdentity::load(&identity_dir)?;
	let allowlist = Allowlist::load(&clients_path)?;
	let server_config = transport::server_config(identity.cert, identity.key, allowlist)?;
	let endpoint = quinn::Endpoint::server(server_config, quic_bind)?;
	let quic_addr = endpoint.local_addr()?;

	let ws_listener = TcpListener::bind(("127.0.0.1", 0)).await?;
	let ws_addr = ws_listener.local_addr()?;

	let rooms = Arc::new(RoomRegistry::default());
	let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
	tokio::spawn(async move {
		loop {
			tokio::select! {
				_ = stop_rx.recv() => {
					endpoint.close(0u32.into(), b"sidecar stopping");
					break;
				}
				stream = endpoint.accept() => {
					let Some(incoming) = stream else { break };
					let rooms = rooms.clone();
					tokio::spawn(async move {
						match incoming.await {
							Ok(connection) => {
								if let Err(error) = accept_quic_guest(connection, rooms).await {
									eprintln!("guest connection ended: {error}");
								}
							}
							Err(error) => eprintln!("handshake rejected: {error}"),
						}
					});
				}
				accepted = ws_listener.accept() => {
					let Ok((socket, _peer)) = accepted else { break };
					let rooms = rooms.clone();
					tokio::spawn(async move {
						if let Err(error) = accept_local_host(socket, rooms).await {
							eprintln!("local host connection ended: {error}");
						}
					});
				}
			}
		}
	});
	Ok(HostHandle { quic_addr, ws_addr, stop: stop_tx })
}

/// Serve the host side until cancelled (CLI entry).
pub async fn serve_host(
	identity_dir: PathBuf,
	clients_path: PathBuf,
	quic_bind: SocketAddr,
) -> Result<(), TransportError> {
	let handle = start_host(identity_dir, clients_path, quic_bind).await?;
	println!("QUIC listening on {}", handle.quic_addr);
	println!("local host surface: ws://{}", handle.ws_addr);
	// Run until the runtime is dropped or SIGINT ends the process.
	futures::future::pending::<()>().await;
	Ok(())
}

/// Accept one QUIC connection from an enrolled guest: the first stream's
/// first framed message is the join; the connection carries one guest peer.
async fn accept_quic_guest(
	connection: quinn::Connection,
	rooms: Arc<RoomRegistry>,
) -> Result<(), RelayError> {
	let (send, mut recv) = connection.accept_bi().await.map_err(quinn_to_relay)?;
	let mut decoder = framing::FrameDecoder::default();
	let mut buffer = vec![0u8; 64 * 1024];
	let join = loop {
		let read = recv
			.read(&mut buffer)
			.await
			.map_err(quinn_read_to_relay)?
			.ok_or(RelayError::Closed)?;
		let messages = decode_stream_message(&buffer[..read], &mut decoder)?;
		if let Some(StreamMessage::Text(payload)) = messages.into_iter().next() {
			break payload;
		}
	};
	let room = parse_join_room(&join)
		.ok_or_else(|| RelayError::Protocol("join message has no room".into()))?;

	let (outbound_tx, mut outbound_rx) = mpsc::channel::<StreamMessage>(BRIDGE_BUFFER);
	let (ready_tx, ready_rx) = oneshot::channel();
	let handle = room_actor(&rooms, &room).await;
	handle
		.send(RoomCommand::Join {
			role:     PeerRole::Guest,
			outbound: outbound_tx.clone(),
			ready:    ready_tx,
		})
		.map_err(|_| RelayError::Protocol("room actor is gone".into()))?;
	let peer_id = ready_rx
		.await
		.map_err(|_| RelayError::Protocol("room actor dropped the join".into()))??;

	// Outbound writer task owns the QUIC send half.
	let writer = tokio::spawn(async move {
		let mut writer = send;
		while let Some(message) = outbound_rx.recv().await {
			let mut encoded = BytesMut::new();
			encode_stream_message(&mut encoded, &message);
			if writer.write_all(&encoded).await.is_err() {
				break;
			}
		}
	});

	// Inbound pump: guest bytes → room actor; on EOF the peer leaves.
	let pump = async {
		loop {
			let read = recv
				.read(&mut buffer)
				.await
				.map_err(quinn_read_to_relay)?
				.ok_or(RelayError::Closed)?;
			if read == 0 {
				break;
			}
			for message in decode_stream_message(&buffer[..read], &mut decoder)? {
				if handle
					.send(RoomCommand::Frame { peer: peer_id, message })
					.is_err()
				{
					return Ok(());
				}
			}
		}
		Ok(())
	};
	let result = pump.await;
	let _ = handle.send(RoomCommand::Leaving { peer: peer_id });
	let _ = writer.await;
	result
}

fn parse_join_room(join: &Bytes) -> Option<String> {
	let value: serde_json::Value = serde_json::from_slice(join).ok()?;
	value.get("room")?.as_str().map(ToOwned::to_owned)
}

async fn room_actor(rooms: &RoomRegistry, room: &str) -> mpsc::UnboundedSender<RoomCommand> {
	rooms
		.rooms
		.lock()
		.await
		.entry(room.to_owned())
		.or_insert_with(|| {
			let (commands, receiver) = mpsc::unbounded_channel();
			tokio::spawn(run_room(receiver));
			commands
		})
		.clone()
}

/// Accept the OMP host process's WebSocket connection on loopback and attach
/// it to its room as the host peer. The role comes from this surface, never
/// from the client.
async fn accept_local_host(
	socket: tokio::net::TcpStream,
	rooms: Arc<RoomRegistry>,
) -> Result<(), RelayError> {
	let (websocket, path) = accept_ws(socket).await?;
	let room = room_of(&path)?;
	attach_local_ws(websocket, rooms, room, PeerRole::Host).await
}

fn room_of(path: &str) -> Result<String, RelayError> {
	path
		.strip_prefix("/r/")
		.and_then(|rest| rest.split('.').next())
		.filter(|room| !room.is_empty())
		.map(ToOwned::to_owned)
		.ok_or_else(|| RelayError::Protocol("request path must be /r/<room>.<key>".into()))
}

/// Accept one local WebSocket and return it together with the request path
/// (the room reference), which tungstenite only exposes through the upgrade
/// callback.
async fn accept_ws(
	socket: tokio::net::TcpStream,
) -> Result<(WebSocketStream<tokio::net::TcpStream>, String), RelayError> {
	let mut config = WebSocketConfig::default();
	config.max_message_size = Some(MAX_WS_MESSAGE);
	let path = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
	let capture_path = path.clone();
	// tungstenite's Callback signature requires this exact shape: a plain
	// Result whose error variant is the handshake ErrorResponse.
	#[allow(clippy::result_large_err, reason = "Callback trait shape is fixed by tungstenite")]
	#[allow(clippy::unnecessary_wraps, reason = "Callback trait shape is fixed by tungstenite")]
	let callback = move |request: &tungstenite::http::Request<()>,
	                     response: tungstenite::http::Response<()>| {
		request.uri().path().clone_into(
			&mut capture_path
				.lock()
				.expect("upgrade callback cannot poison after drop"),
		);
		Ok::<_, tungstenite::handshake::server::ErrorResponse>(response)
	};
	let websocket = tokio_tungstenite::accept_hdr_async_with_config(socket, callback, Some(config))
		.await
		.map_err(|error| RelayError::Protocol(format!("ws upgrade failed: {error}")))?;
	let path = Arc::try_unwrap(path)
		.map_or_default(|mutex| mutex.into_inner().expect("upgrade callback finished"));
	Ok((websocket, path))
}

/// Attach a local WebSocket peer to its room and pump both directions.
async fn attach_local_ws(
	websocket: WebSocketStream<tokio::net::TcpStream>,
	rooms: Arc<RoomRegistry>,
	room: String,
	role: PeerRole,
) -> Result<(), RelayError> {
	let (outbound_tx, mut outbound_rx) = mpsc::channel::<StreamMessage>(BRIDGE_BUFFER);
	let (ready_tx, ready_rx) = oneshot::channel();
	let handle = room_actor(&rooms, &room).await;
	handle
		.send(RoomCommand::Join { role, outbound: outbound_tx.clone(), ready: ready_tx })
		.map_err(|_| RelayError::Protocol("room actor is gone".into()))?;
	let peer_id = ready_rx
		.await
		.map_err(|_| RelayError::Protocol("room actor dropped the join".into()))??;

	let (mut ws_sink, mut ws_stream) = websocket.split();
	// Room → WS writer task.
	let writer = tokio::spawn(async move {
		while let Some(message) = outbound_rx.recv().await {
			let ws_message = match message {
				StreamMessage::Binary(payload) => Message::Binary(payload.to_vec().into()),
				StreamMessage::Text(payload) => {
					Message::Text(String::from_utf8_lossy(&payload).into_owned().into())
				},
			};
			if ws_sink.send(ws_message).await.is_err() {
				break;
			}
		}
	});
	// WS → room pump.
	let pump = async {
		while let Some(message) = ws_stream.next().await {
			match message? {
				Message::Binary(payload) => {
					let message = StreamMessage::Binary(payload);
					if handle
						.send(RoomCommand::Frame { peer: peer_id, message })
						.is_err()
					{
						return Ok(());
					}
				},
				Message::Text(_text) => {
					// Inbound text from a peer is not part of the relay
					// contract; ignore it rather than treating it as fatal.
				},
				Message::Ping(_) | Message::Pong(_) => {},
				Message::Close(_) => return Ok(()),
				Message::Frame(_) => {},
			}
		}
		Ok(())
	};
	let result = pump.await;
	let _ = handle.send(RoomCommand::Leaving { peer: peer_id });
	writer.abort();
	result
}

// ─────────────────────────────────────────────────────────────────────────────
// Guest side
// ─────────────────────────────────────────────────────────────────────────────

/// A running guest sidecar: the local WS surface address for the OMP guest.
pub struct GuestHandle {
	/// Local WebSocket surface for the OMP guest process.
	pub ws_addr: SocketAddr,
}

/// Start the guest side: dial the pinned host over QUIC once, then expose a
/// local WebSocket listener that the OMP guest process connects to.
///
/// Every local WS connection becomes one QUIC stream and therefore one guest
/// peer.
pub async fn start_guest(
	identity_dir: PathBuf,
	server: SocketAddr,
	pin: &str,
) -> Result<GuestHandle, TransportError> {
	let identity = EndpointIdentity::load(&identity_dir)?;
	let pinned = transport::PinnedServerVerifier::from_hex(pin)?;
	let client_config = transport::client_config(identity.cert, identity.key, pinned.pin)?;
	let endpoint = quinn::Endpoint::client("0.0.0.0:0".parse().expect("ephemeral bind"))?;
	let connection = endpoint
		.connect_with(client_config, server, "omp-remote")
		.map_err(TransportError::from)?
		.await
		.map_err(|error| TransportError::Config(error.to_string()))?;

	let ws_listener = TcpListener::bind(("127.0.0.1", 0)).await?;
	let ws_addr = ws_listener.local_addr()?;
	tokio::spawn(async move {
		loop {
			let Ok((socket, _peer)) = ws_listener.accept().await else {
				break;
			};
			let connection = connection.clone();
			tokio::spawn(async move {
				if let Err(error) = bridge_local_ws_to_quic(socket, connection).await {
					eprintln!("local guest bridge ended: {error}");
				}
			});
		}
	});
	Ok(GuestHandle { ws_addr })
}

/// Serve the guest side until cancelled (CLI entry).
pub async fn serve_guest(
	identity_dir: PathBuf,
	server: SocketAddr,
	pin: &str,
) -> Result<(), TransportError> {
	let handle = start_guest(identity_dir, server, pin).await?;
	println!("local guest surface: ws://{}", handle.ws_addr);
	futures::future::pending::<()>().await;
	Ok(())
}

/// Guest side: one local WS connection ↔ one QUIC stream on the pinned host.
async fn bridge_local_ws_to_quic(
	socket: tokio::net::TcpStream,
	connection: quinn::Connection,
) -> Result<(), RelayError> {
	let (websocket, path) = accept_ws(socket).await?;
	let room = room_of(&path)?;

	let (mut send, mut recv) = connection.open_bi().await.map_err(quinn_to_relay)?;
	let mut encoder = BytesMut::new();
	let join = serde_json::json!({ "t": "join", "room": room }).to_string();
	encode_stream_message(&mut encoder, &StreamMessage::Text(Bytes::from(join)));
	send
		.write_all(&encoder)
		.await
		.map_err(quinn_write_to_relay)?;

	let (mut ws_sink, mut ws_stream) = websocket.split();
	// WS → QUIC.
	let ws_to_quic = tokio::spawn(async move {
		let mut send = send;
		while let Some(message) = ws_stream.next().await {
			match message {
				Ok(Message::Binary(payload)) => {
					let mut encoded = BytesMut::new();
					encode_stream_message(&mut encoded, &StreamMessage::Binary(payload));
					if send.write_all(&encoded).await.is_err() {
						break;
					}
				},
				Ok(Message::Text(text)) => {
					let mut encoded = BytesMut::new();
					encode_stream_message(
						&mut encoded,
						&StreamMessage::Text(Bytes::from(text.as_bytes().to_vec())),
					);
					if send.write_all(&encoded).await.is_err() {
						break;
					}
				},
				Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)) => {},
				Ok(Message::Close(_)) | Err(_) => break,
			}
		}
	});
	// QUIC → WS.
	let mut decoder = framing::FrameDecoder::default();
	let mut buffer = vec![0u8; 64 * 1024];
	let result = loop {
		let read = recv
			.read(&mut buffer)
			.await
			.map_err(quinn_read_to_relay)?
			.ok_or(RelayError::Closed)?;
		if read == 0 {
			break Ok(());
		}
		let messages = decode_stream_message(&buffer[..read], &mut decoder)?;
		for message in messages {
			let ws_message = match message {
				StreamMessage::Binary(payload) => Message::Binary(payload.to_vec().into()),
				StreamMessage::Text(payload) => {
					Message::Text(String::from_utf8_lossy(&payload).into_owned().into())
				},
			};
			if ws_sink.send(ws_message).await.is_err() {
				break;
			}
		}
	};
	ws_to_quic.abort();
	result
}
