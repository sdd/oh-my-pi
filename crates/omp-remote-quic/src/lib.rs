//! Library surface for `omp-remote-quic`: the sidecar modules and the public
//! handles tests and the CLI binary share.

pub mod enrollment;
pub mod framing;
pub mod identity;
pub mod relay;
pub mod transport;

pub use transport::TransportError;

/// The sidecar never carries an application frame larger than this.
///
/// The paged history protocol bounds pages to 64 KiB, but legacy snapshot
/// chunks and transcript reads may legitimately exceed that; 4 MiB matches the
/// transcript fetch cap in the TypeScript host.
pub const MAX_FRAME_BYTES: u32 = 4 * 1024 * 1024;
