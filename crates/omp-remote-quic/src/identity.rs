//! Local identity: a self-signed certificate plus key, and its SHA-256
//! fingerprint. Fingerprints — not CA chains — are what both sides pin, so a
//! compromised CA cannot silently re-issue either identity.

use std::path::Path;

use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
	#[error("cannot read {path:?}: {source}")]
	Read {
		path:   std::path::PathBuf,
		#[source]
		source: std::io::Error,
	},
	#[error("cannot write {path:?}: {source}")]
	Write {
		path:   std::path::PathBuf,
		#[source]
		source: std::io::Error,
	},
	#[error("cannot generate identity: {0}")]
	Generate(String),
	#[error("cannot parse PEM in {0}")]
	Pem(String),
}

/// A loaded certificate with its pinned fingerprint.
#[derive(Debug, Clone)]
pub struct CertificateIdentity {
	pub cert:        CertificateDer<'static>,
	/// SHA-256 over the DER certificate; the byte form both sides pin.
	pub fingerprint: [u8; 32],
}

impl CertificateIdentity {
	/// Lowercase hex fingerprint, the form persisted in pin/enrollment files.
	pub fn fingerprint_hex(&self) -> String {
		fingerprint_hex(&self.fingerprint)
	}
}

/// A full local identity for a QUIC endpoint: certificate and private key.
#[derive(Debug)]
pub struct EndpointIdentity {
	pub cert:        CertificateDer<'static>,
	pub key:         PrivateKeyDer<'static>,
	pub fingerprint: [u8; 32],
}

impl EndpointIdentity {
	pub fn fingerprint_hex(&self) -> String {
		fingerprint_hex(&self.fingerprint)
	}

	/// Load `cert.pem` + `key.pem` from an identity directory.
	pub fn load(dir: &Path) -> Result<Self, IdentityError> {
		let certificate = load_cert(&dir.join("cert.pem"))?;
		let key = load_key(&dir.join("key.pem"))?;
		Ok(Self { cert: certificate.cert, key, fingerprint: certificate.fingerprint })
	}
}

pub fn fingerprint_hex(fingerprint: &[u8; 32]) -> String {
	fingerprint
		.iter()
		.fold(String::with_capacity(64), |mut out, byte| {
			use std::fmt::Write as _;
			let _ = write!(out, "{byte:02x}");
			out
		})
}

/// Parse a 64-char hex fingerprint into bytes.
pub fn parse_fingerprint(hex: &str) -> Result<[u8; 32], String> {
	let hex = hex.trim().to_lowercase();
	if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
		return Err(format!("fingerprint must be 64 hex chars, got {hex:?}"));
	}
	let mut out = [0u8; 32];
	for (index, chunk) in hex.as_bytes().chunks(2).enumerate() {
		let high = (chunk[0] as char).to_digit(16).expect("validated hex") as u8;
		let low = (chunk[1] as char).to_digit(16).expect("validated hex") as u8;
		out[index] = (high << 4) | low;
	}
	Ok(out)
}

/// SHA-256 over raw DER bytes.
pub fn sha256_of(data: &[u8]) -> [u8; 32] {
	use ring::digest::{SHA256, digest};
	let mut out = [0u8; 32];
	out.copy_from_slice(digest(&SHA256, data).as_ref());
	out
}

#[derive(Debug, Serialize, Deserialize)]
struct IdentityMeta {
	name:       String,
	created_at: u64,
}

/// Generate a fresh self-signed identity into `dir` (`cert.pem`, `key.pem`).
///
/// The key is created with owner-only permissions; the certificate is public.
pub fn generate_identity(dir: &Path, name: &str) -> Result<(), IdentityError> {
	let key_pair =
		rcgen::KeyPair::generate().map_err(|error| IdentityError::Generate(error.to_string()))?;
	let mut params = rcgen::CertificateParams::new(vec![name.to_owned()])
		.map_err(|error| IdentityError::Generate(error.to_string()))?;
	// Ten years: the sidecar's identity is infrastructure, not a web
	// certificate.
	params.not_after = rcgen::date_time_ymd(2036, 11, 17);
	let certificate = params
		.self_signed(&key_pair)
		.map_err(|error| IdentityError::Generate(error.to_string()))?;

	std::fs::create_dir_all(dir)
		.map_err(|source| IdentityError::Write { path: dir.to_owned(), source })?;
	write_private(&dir.join("cert.pem"), &certificate.pem())?;
	write_private(&dir.join("key.pem"), &key_pair.serialize_pem())?;
	let meta = IdentityMeta { name: name.to_owned(), created_at: unix_seconds() };
	write_private(
		&dir.join("identity.json"),
		&serde_json::to_string_pretty(&meta).expect("metadata always serializes"),
	)?;
	Ok(())
}

fn write_private(path: &Path, contents: &str) -> Result<(), IdentityError> {
	std::fs::write(path, contents)
		.map_err(|source| IdentityError::Write { path: path.to_owned(), source })?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
			.map_err(|source| IdentityError::Write { path: path.to_owned(), source })?;
	}
	Ok(())
}

fn unix_seconds() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map_or_default(|duration| duration.as_secs())
}

/// Load a PEM certificate file into a DER certificate plus fingerprint.
pub fn load_cert(path: &Path) -> Result<CertificateIdentity, IdentityError> {
	let pem = std::fs::read_to_string(path)
		.map_err(|source| IdentityError::Read { path: path.to_owned(), source })?;
	let body = first_pem_block(&pem, "CERTIFICATE", path)?;
	let der = base64_decode(&body)
		.ok_or_else(|| IdentityError::Pem(format!("malformed base64 in {}", path.display())))?;
	let cert = CertificateDer::from(der);
	let fingerprint = sha256_of(cert.as_ref());
	Ok(CertificateIdentity { cert, fingerprint })
}

/// Load a PEM private key file into a DER key (PKCS#8 or SEC1 both map to
/// `PrivateKeyDer` variants rustls accepts for QUIC).
pub fn load_key(path: &Path) -> Result<PrivateKeyDer<'static>, IdentityError> {
	let pem = std::fs::read_to_string(path)
		.map_err(|source| IdentityError::Read { path: path.to_owned(), source })?;
	for label in ["PRIVATE KEY", "EC PRIVATE KEY", "RSA PRIVATE KEY"] {
		if let Ok(body) = first_pem_block(&pem, label, path)
			&& let Some(der) = base64_decode(&body)
		{
			return match label {
				"PRIVATE KEY" => Ok(PrivateKeyDer::Pkcs8(der.into())),
				"EC PRIVATE KEY" => Ok(PrivateKeyDer::Sec1(der.into())),
				_ => Ok(PrivateKeyDer::Pkcs1(der.into())),
			};
		}
	}
	Err(IdentityError::Pem(format!("no recognizable key block in {}", path.display())))
}

/// Extract the first PEM block body with the given label.
fn first_pem_block(pem: &str, label: &str, path: &Path) -> Result<String, IdentityError> {
	let begin = format!("-----BEGIN {label}-----");
	let end = format!("-----END {label}-----");
	let start = pem
		.find(&begin)
		.ok_or_else(|| IdentityError::Pem(format!("no {label} block in {}", path.display())))?
		+ begin.len();
	let stop = pem[start..].find(&end).ok_or_else(|| {
		IdentityError::Pem(format!("unterminated {label} block in {}", path.display()))
	})? + start;
	Ok(pem[start..stop]
		.chars()
		.filter(|c| !c.is_whitespace())
		.collect())
}

/// Standard base64 decode (no padding requirement beyond the PEM default).
fn base64_decode(input: &str) -> Option<Vec<u8>> {
	let mut out = Vec::with_capacity(input.len() * 3 / 4);
	let mut buffer = 0u32;
	let mut bits = 0u32;
	for character in input.chars() {
		let value = match character {
			'A'..='Z' => u32::from(character) - u32::from('A'),
			'a'..='z' => u32::from(character) - u32::from('a') + 26,
			'0'..='9' => u32::from(character) - u32::from('0') + 52,
			'+' => 62,
			'/' => 63,
			'=' | '\n' | '\r' => continue,
			_ => return None,
		};
		buffer = (buffer << 6) | value;
		bits += 6;
		if bits >= 8 {
			bits -= 8;
			out.push((buffer >> bits) as u8);
		}
	}
	Some(out)
}
