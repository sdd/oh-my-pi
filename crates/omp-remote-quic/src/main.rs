//! The sidecar binary: thin CLI over the library. Commands cover identity
//! generation, fingerprinting, enrollment, and the two long-running modes
//! (`serve` = host side, `connect` = guest side).

use std::{net::SocketAddr, path::PathBuf, process::ExitCode};

use omp_remote_quic::{TransportError, enrollment, identity, relay};

/// The CLI surfaces transport-layer failures directly.
type SidecarError = TransportError;

pub enum Command {
	/// Generate a fresh identity (certificate + key) into a directory.
	GenerateIdentity { out: PathBuf, name: String },
	/// Print the SHA-256 fingerprint of a certificate file.
	Fingerprint { cert: PathBuf },
	/// Add or update a client enrollment entry.
	Enroll {
		clients:     PathBuf,
		fingerprint: String,
		name:        String,
		role:        enrollment::Role,
	},
	/// Revoke an enrolled client fingerprint.
	Revoke { clients: PathBuf, fingerprint: String },
	/// Run the host side: local WebSocket surface + QUIC listener.
	Serve { identity: PathBuf, clients: PathBuf, bind: SocketAddr },
	/// Run the guest side: QUIC connection to the pinned host + local WebSocket
	/// surface.
	Connect { identity: PathBuf, server: SocketAddr, pin: String },
}

impl Command {
	/// Parse the sidecar command line. `args` excludes the program name.
	pub fn parse(args: &[String]) -> Result<Self, String> {
		let mut args = args.iter();
		let command = args
			.next()
			.ok_or("usage: omp-remote-quic <command> [args]")?;
		let mut rest: Vec<String> = args.cloned().collect();
		match command.as_str() {
			"identity" => {
				let name = pop_value(&mut rest, "--name")?;
				let out = pop_value(&mut rest, "--out")?;
				Ok(Self::GenerateIdentity { out: PathBuf::from(out), name })
			},
			"fingerprint" => {
				let cert = pop_value(&mut rest, "--cert")?;
				Ok(Self::Fingerprint { cert: PathBuf::from(cert) })
			},
			"enroll" => {
				let clients = pop_value(&mut rest, "--clients")?;
				let fingerprint = pop_value(&mut rest, "--fingerprint")?;
				let name = pop_value(&mut rest, "--name")?;
				let role = match pop_value(&mut rest, "--role")?.as_str() {
					"read" => enrollment::Role::Read,
					"write" => enrollment::Role::Write,
					other => return Err(format!("unknown role {other}; expected read or write")),
				};
				Ok(Self::Enroll { clients: PathBuf::from(clients), fingerprint, name, role })
			},
			"revoke" => {
				let clients = pop_value(&mut rest, "--clients")?;
				let fingerprint = pop_value(&mut rest, "--fingerprint")?;
				Ok(Self::Revoke { clients: PathBuf::from(clients), fingerprint })
			},
			"serve" => {
				let identity = PathBuf::from(pop_value(&mut rest, "--identity")?);
				let clients = PathBuf::from(pop_value(&mut rest, "--clients")?);
				let bind = pop_value(&mut rest, "--bind")?;
				let addr = bind
					.parse()
					.map_err(|error| format!("invalid --bind {bind}: {error}"))?;
				Ok(Self::Serve { identity, clients, bind: addr })
			},
			"connect" => {
				let identity = PathBuf::from(pop_value(&mut rest, "--identity")?);
				let server = pop_value(&mut rest, "--server")?;
				let addr = server
					.parse()
					.map_err(|error| format!("invalid --server {server}: {error}"))?;
				let pin = pop_value(&mut rest, "--pin")?;
				Ok(Self::Connect { identity, server: addr, pin })
			},
			other => Err(format!(
				"unknown command {other}; expected identity, fingerprint, enroll, revoke, serve or \
				 connect"
			)),
		}
	}

	/// Execute the command. `serve` and `connect` run until cancelled.
	pub async fn run(self) -> Result<(), SidecarError> {
		match self {
			Self::GenerateIdentity { out, name } => {
				identity::generate_identity(&out, &name)?;
				println!("identity written to {}", out.display());
				let cert = identity::load_cert(&out.join("cert.pem"))?;
				println!("fingerprint {}", cert.fingerprint_hex());
			},
			Self::Fingerprint { cert } => {
				let cert = identity::load_cert(&cert)?;
				println!("{}", cert.fingerprint_hex());
			},
			Self::Enroll { clients, fingerprint, name, role } => {
				enrollment::enroll(&clients, &fingerprint, &name, role)?;
				println!("enrolled {fingerprint} as {name} ({role:?})");
			},
			Self::Revoke { clients, fingerprint } => {
				enrollment::revoke(&clients, &fingerprint)?;
				println!("revoked {fingerprint}");
			},
			Self::Serve { identity, clients, bind } => {
				relay::serve_host(identity, clients, bind).await?;
			},
			Self::Connect { identity, server, pin } => {
				relay::serve_guest(identity, server, &pin).await?;
			},
		}
		Ok(())
	}
}

fn pop_value(args: &mut Vec<String>, flag: &str) -> Result<String, String> {
	let index = args
		.iter()
		.position(|arg| arg == flag)
		.ok_or_else(|| format!("missing {flag}"))?;
	let value = args
		.get(index + 1)
		.ok_or_else(|| format!("{flag} needs a value"))?
		.clone();
	args.remove(index);
	args.remove(index);
	Ok(value)
}

fn main() -> ExitCode {
	let args: Vec<String> = std::env::args().skip(1).collect();
	let command = match Command::parse(&args) {
		Ok(command) => command,
		Err(usage) => {
			eprintln!("{usage}");
			return ExitCode::from(2);
		},
	};
	let runtime = match tokio::runtime::Builder::new_multi_thread()
		.enable_all()
		.build()
	{
		Ok(runtime) => runtime,
		Err(error) => {
			eprintln!("runtime: {error}");
			return ExitCode::FAILURE;
		},
	};
	match runtime.block_on(command.run()) {
		Ok(()) => ExitCode::SUCCESS,
		Err(error) => {
			eprintln!("{error}");
			ExitCode::FAILURE
		},
	}
}
