//! Client enrollment: an explicit allowlist of certificate fingerprints.
//!
//! A shared CA alone cannot revoke an individual client, so the host verifies
//! each client certificate against this allowlist instead. Every entry carries
//! a display name, a role, and a revocation flag; revoked fingerprints are
//! kept in the file so a revoked client's re-enrollment attempt is visible.

use std::{collections::BTreeMap, path::Path};

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum EnrollmentError {
	#[error("io: {0}")]
	Io(#[from] std::io::Error),
	#[error("serialization: {0}")]
	Json(#[from] serde_json::Error),
	#[error("{0}")]
	Invalid(String),
}

/// Authorization tier of an enrolled client.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
	/// May open streams; the OMP host still enforces its own write-token rules.
	Read,
	/// Full bridge access.
	Write,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Enrollment {
	pub fingerprint: String,
	pub name:        String,
	pub role:        Role,
	pub revoked:     bool,
	pub enrolled_at: u64,
}

/// The allowlist file: fingerprint → entry, deterministic order.
#[derive(Debug, Default, Clone)]
pub struct Allowlist {
	entries: BTreeMap<String, Enrollment>,
}

impl Allowlist {
	pub fn load(path: &Path) -> Result<Self, EnrollmentError> {
		match std::fs::read_to_string(path) {
			Ok(text) => {
				let entries: Vec<Enrollment> = serde_json::from_str(&text)?;
				let mut map = BTreeMap::new();
				for entry in entries {
					validate_fingerprint(&entry.fingerprint)?;
					if map.insert(entry.fingerprint.clone(), entry).is_some() {
						return Err(EnrollmentError::Invalid(format!(
							"duplicate fingerprint in {}",
							path.display()
						)));
					}
				}
				Ok(Self { entries: map })
			},
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
			Err(error) => Err(EnrollmentError::Io(error)),
		}
	}

	pub fn save(&self, path: &Path) -> Result<(), EnrollmentError> {
		let entries: Vec<&Enrollment> = self.entries.values().collect();
		let json = serde_json::to_string_pretty(&entries)?;
		if let Some(parent) = path.parent() {
			std::fs::create_dir_all(parent)?;
		}
		std::fs::write(path, json)?;
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
		}
		Ok(())
	}

	/// The decision for a client fingerprint: allowed at the given role, or the
	/// reason.
	pub fn check(&self, fingerprint: &[u8; 32]) -> Result<Role, Rejection> {
		let hex = crate::identity::fingerprint_hex(fingerprint);
		match self.entries.get(&hex) {
			Some(entry) if entry.revoked => Err(Rejection::Revoked),
			Some(entry) => Ok(entry.role),
			None => Err(Rejection::Unknown),
		}
	}

	pub fn enroll(
		&mut self,
		fingerprint: &str,
		name: &str,
		role: Role,
	) -> Result<(), EnrollmentError> {
		validate_fingerprint(fingerprint)?;
		if name.trim().is_empty() {
			return Err(EnrollmentError::Invalid("enrollment name must not be empty".into()));
		}
		self.entries.insert(fingerprint.to_lowercase(), Enrollment {
			fingerprint: fingerprint.to_lowercase(),
			name: name.trim().to_owned(),
			role,
			revoked: false,
			enrolled_at: unix_seconds(),
		});
		Ok(())
	}

	pub fn revoke(&mut self, fingerprint: &str) -> Result<(), EnrollmentError> {
		validate_fingerprint(fingerprint)?;
		let key = fingerprint.to_lowercase();
		match self.entries.get_mut(&key) {
			Some(entry) => entry.revoked = true,
			None => {
				self.entries.insert(key.clone(), Enrollment {
					fingerprint: key,
					name:        "revoked".into(),
					role:        Role::Read,
					revoked:     true,
					enrolled_at: unix_seconds(),
				});
			},
		}
		Ok(())
	}

	pub const fn len(&self) -> usize {
		self.entries.len()
	}

	pub const fn is_empty(&self) -> bool {
		self.entries.is_empty()
	}
}

#[derive(Debug, PartialEq, Eq)]
pub enum Rejection {
	/// The fingerprint was enrolled once and has been revoked.
	Revoked,
	/// The fingerprint was never enrolled.
	Unknown,
}

fn validate_fingerprint(fingerprint: &str) -> Result<(), EnrollmentError> {
	let is_hex64 = fingerprint.len() == 64 && fingerprint.chars().all(|c| c.is_ascii_hexdigit());
	if !is_hex64 {
		return Err(EnrollmentError::Invalid(format!(
			"fingerprint must be 64 hex chars: {fingerprint}"
		)));
	}
	Ok(())
}

fn unix_seconds() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map_or_default(|duration| duration.as_secs())
}

/// Add or update one enrollment entry on disk.
pub fn enroll(
	path: &Path,
	fingerprint: &str,
	name: &str,
	role: Role,
) -> Result<(), EnrollmentError> {
	let mut list = Allowlist::load(path)?;
	list.enroll(fingerprint, name, role)?;
	list.save(path)
}

/// Mark one fingerprint revoked on disk (created if it was never enrolled).
pub fn revoke(path: &Path, fingerprint: &str) -> Result<(), EnrollmentError> {
	let mut list = Allowlist::load(path)?;
	list.revoke(fingerprint)?;
	list.save(path)
}
