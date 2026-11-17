//! QUIC endpoint configuration: server pinning on the client side, explicit
//! client-fingerprint allowlisting on the server side.
//!
//! Neither side consults a CA chain:
//! - The client accepts exactly one server certificate — the pinned
//!   fingerprint. Hostname validation plays no role; the pin IS the identity.
//! - The server accepts exactly the enrolled, non-revoked client fingerprints.
//!   A shared CA alone could not revoke one client, so the allowlist is the
//!   trust store.
//!
//! Handshake signature verification (proof of key possession) delegates to
//! rustls's webpki verification against the ring provider's algorithm set.

use std::sync::{Arc, LazyLock};

use rustls::{
	DigitallySignedStruct, SignatureScheme,
	client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
	crypto::{CryptoProvider, WebPkiSupportedAlgorithms, verify_tls13_signature},
	pki_types::{CertificateDer, PrivateKeyDer, UnixTime},
	server::danger::{ClientCertVerified, ClientCertVerifier},
};

use crate::{
	enrollment::{Allowlist, Role},
	identity,
};

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
	#[error("{0}")]
	Config(String),
	#[error("quinn connect: {0}")]
	Connect(#[from] quinn::ConnectError),
	#[error("rustls: {0}")]
	Rustls(#[from] rustls::Error),
	#[error("io: {0}")]
	Io(#[from] std::io::Error),
	#[error("identity: {0}")]
	Identity(#[from] crate::identity::IdentityError),
	#[error("enrollment: {0}")]
	Enrollment(#[from] crate::enrollment::EnrollmentError),
}

/// The ring provider's signature-verification algorithm set, shared by both
/// custom verifiers for proof-of-possession checks.
static VERIFICATION_ALGORITHMS: LazyLock<WebPkiSupportedAlgorithms> = LazyLock::new(|| {
	let provider: CryptoProvider = rustls::crypto::ring::default_provider();
	provider.signature_verification_algorithms
});

/// Handshake signature checks shared by both custom verifiers. QUIC uses only
/// TLS 1.3, but rustls requires both trait methods.
fn verify_signature(
	message: &[u8],
	cert: &CertificateDer<'_>,
	dss: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, rustls::Error> {
	verify_tls13_signature(message, cert, dss, &VERIFICATION_ALGORITHMS)
}

/// The ALPN protocol the sidecar speaks. Distinct from any web ALPN so a
/// plain TLS client cannot mistake this endpoint for a web service.
pub const ALPN: &[u8] = b"omp-remote/1";

/// Client-side verifier: the server certificate must hash to the pinned
/// fingerprint.
#[derive(Debug)]
pub struct PinnedServerVerifier {
	pub(crate) pin: [u8; 32],
}

impl PinnedServerVerifier {
	pub const fn new(pin: [u8; 32]) -> Self {
		Self { pin }
	}

	pub fn from_hex(pin: &str) -> Result<Self, TransportError> {
		identity::parse_fingerprint(pin)
			.map(Self::new)
			.map_err(TransportError::Config)
	}
}

impl ServerCertVerifier for PinnedServerVerifier {
	fn verify_server_cert(
		&self,
		end_entity: &CertificateDer<'_>,
		_intermediates: &[CertificateDer<'_>],
		_server_name: &rustls::pki_types::ServerName<'_>,
		_ocsp_response: &[u8],
		_now: UnixTime,
	) -> Result<ServerCertVerified, rustls::Error> {
		if identity::sha256_of(end_entity.as_ref()) == self.pin {
			Ok(ServerCertVerified::assertion())
		} else {
			Err(rustls::Error::General(
				"server certificate does not match the pinned fingerprint".into(),
			))
		}
	}

	fn verify_tls12_signature(
		&self,
		_message: &[u8],
		_cert: &CertificateDer<'_>,
		_dss: &DigitallySignedStruct,
	) -> Result<HandshakeSignatureValid, rustls::Error> {
		// QUIC never runs TLS 1.2; the trait only requires the method to exist.
		Err(rustls::Error::General("TLS 1.2 is not supported".into()))
	}

	fn verify_tls13_signature(
		&self,
		message: &[u8],
		cert: &CertificateDer<'_>,
		dss: &DigitallySignedStruct,
	) -> Result<HandshakeSignatureValid, rustls::Error> {
		verify_signature(message, cert, dss)
	}

	fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
		VERIFICATION_ALGORITHMS.supported_schemes()
	}
}

/// Server-side verifier: the client certificate must be an enrolled,
/// non-revoked fingerprint. Client authentication is mandatory.
#[derive(Debug)]
pub struct AllowlistClientVerifier {
	allowlist: Allowlist,
}

impl AllowlistClientVerifier {
	pub const fn new(allowlist: Allowlist) -> Self {
		Self { allowlist }
	}

	/// The role the presented client was enrolled for, or `None` when the
	/// certificate is unknown or revoked.
	pub fn role_of(&self, cert: &CertificateDer<'_>) -> Option<Role> {
		self
			.allowlist
			.check(&identity::sha256_of(cert.as_ref()))
			.ok()
	}
}

impl ClientCertVerifier for AllowlistClientVerifier {
	fn offer_client_auth(&self) -> bool {
		true
	}

	fn client_auth_mandatory(&self) -> bool {
		true
	}

	fn root_hint_subjects(&self) -> &[rustls::DistinguishedName] {
		// No CA hints: enrollment is fingerprint-based, so clients present
		// their own certificate rather than selecting one for a CA name.
		&[]
	}

	fn verify_client_cert(
		&self,
		end_entity: &CertificateDer<'_>,
		_intermediates: &[CertificateDer<'_>],
		_now: UnixTime,
	) -> Result<ClientCertVerified, rustls::Error> {
		let fingerprint = identity::sha256_of(end_entity.as_ref());
		match self.allowlist.check(&fingerprint) {
			Ok(_) => Ok(ClientCertVerified::assertion()),
			Err(crate::enrollment::Rejection::Revoked) => {
				Err(rustls::Error::General("client certificate has been revoked".into()))
			},
			Err(crate::enrollment::Rejection::Unknown) => {
				Err(rustls::Error::General("client certificate is not enrolled".into()))
			},
		}
	}

	fn verify_tls12_signature(
		&self,
		_message: &[u8],
		_cert: &CertificateDer<'_>,
		_dss: &DigitallySignedStruct,
	) -> Result<HandshakeSignatureValid, rustls::Error> {
		Err(rustls::Error::General("TLS 1.2 is not supported".into()))
	}

	fn verify_tls13_signature(
		&self,
		message: &[u8],
		cert: &CertificateDer<'_>,
		dss: &DigitallySignedStruct,
	) -> Result<HandshakeSignatureValid, rustls::Error> {
		verify_signature(message, cert, dss)
	}

	fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
		VERIFICATION_ALGORITHMS.supported_schemes()
	}
}

/// Build the server-side QUIC config: our own cert/key plus the allowlist
/// client verifier.
pub fn server_config(
	cert: CertificateDer<'static>,
	key: PrivateKeyDer<'static>,
	allowlist: Allowlist,
) -> Result<quinn::ServerConfig, TransportError> {
	let verifier = Arc::new(AllowlistClientVerifier::new(allowlist));
	let mut tls =
		rustls::ServerConfig::builder_with_provider(rustls::crypto::ring::default_provider().into())
			.with_protocol_versions(&[&rustls::version::TLS13])
			.expect("TLS 1.3 is supported by the ring provider")
			.with_client_cert_verifier(verifier)
			.with_single_cert(vec![cert], key)?;
	// Both sides must agree on the sidecar ALPN; a plain web client fails here.
	tls.alpn_protocols = vec![ALPN.to_vec()];
	let quic_tls = quinn::crypto::rustls::QuicServerConfig::try_from(tls)
		.map_err(|error| TransportError::Config(format!("QUIC TLS conversion: {error}")))?;
	let mut config = quinn::ServerConfig::with_crypto(Arc::new(quic_tls));
	// The bridge uses exactly one stream per guest connection; headroom stays
	// small so a hostile peer cannot open unbounded streams.
	let mut transport = quinn::TransportConfig::default();
	transport.max_concurrent_bidi_streams(8_u32.into());
	transport.max_concurrent_uni_streams(0_u32.into());
	config.transport_config(Arc::new(transport));
	Ok(config)
}

/// Build the client-side QUIC config against a pinned server fingerprint,
/// presenting our own client certificate.
pub fn client_config(
	cert: CertificateDer<'static>,
	key: PrivateKeyDer<'static>,
	pin: [u8; 32],
) -> Result<quinn::ClientConfig, TransportError> {
	let verifier = Arc::new(PinnedServerVerifier::new(pin));
	let mut tls =
		rustls::ClientConfig::builder_with_provider(rustls::crypto::ring::default_provider().into())
			.with_protocol_versions(&[&rustls::version::TLS13])
			.expect("TLS 1.3 is supported by the ring provider")
			.dangerous()
			.with_custom_certificate_verifier(verifier)
			.with_client_auth_cert(vec![cert], key)?;
	// Both sides must agree on the sidecar ALPN; a plain web client fails here.
	tls.alpn_protocols = vec![ALPN.to_vec()];
	let quic_tls = quinn::crypto::rustls::QuicClientConfig::try_from(tls)
		.map_err(|error| TransportError::Config(format!("QUIC TLS conversion: {error}")))?;
	let mut config = quinn::ClientConfig::new(Arc::new(quic_tls));
	let mut transport = quinn::TransportConfig::default();
	// Idle guests on trains may sit behind lossy paths; gentle keep-alives
	// keep the NAT binding and the connection alive without flooding.
	transport.keep_alive_interval(Some(std::time::Duration::from_secs(5)));
	config.transport_config(Arc::new(transport));
	Ok(config)
}
