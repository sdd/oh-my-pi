//! Bounded application framing over QUIC streams.
//!
//! A u32 big-endian length prefix followed by that many payload bytes. Lengths
//! beyond [`MAX_FRAME_BYTES`] abort the connection: an unbounded frame is a
//! memory exhaustion vector, not a feature.

use bytes::{BufMut, Bytes, BytesMut};

use crate::MAX_FRAME_BYTES;

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
	#[error("frame of {0} bytes exceeds the {MAX_FRAME_BYTES}-byte cap")]
	Oversized(u32),
	#[error("io: {0}")]
	Io(#[from] std::io::Error),
}

/// Encode one length-prefixed frame into `out`.
pub fn encode_frame(out: &mut BytesMut, payload: &[u8]) -> Result<(), FrameError> {
	let length = u32::try_from(payload.len()).map_err(|_| FrameError::Oversized(u32::MAX))?;
	if length > MAX_FRAME_BYTES {
		return Err(FrameError::Oversized(length));
	}
	out.reserve(4 + payload.len());
	out.put_u32(length);
	out.put_slice(payload);
	Ok(())
}

/// Incremental frame decoder with an explicit maximum, so a peer cannot make
/// us buffer an unbounded prefix before the length is even known.
#[derive(Debug, Default)]
pub struct FrameDecoder {
	buffer: BytesMut,
}

impl FrameDecoder {
	/// Feed wire bytes; returns every complete frame now available.
	pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Bytes>, FrameError> {
		self.buffer.extend_from_slice(chunk);
		let mut frames = Vec::new();
		loop {
			if self.buffer.len() < 4 {
				break;
			}
			let length =
				u32::from_be_bytes([self.buffer[0], self.buffer[1], self.buffer[2], self.buffer[3]]);
			if length > MAX_FRAME_BYTES {
				return Err(FrameError::Oversized(length));
			}
			let length = length as usize;
			if self.buffer.len() < 4 + length {
				break;
			}
			let mut frame = self.buffer.split_to(4 + length);
			frames.push(frame.split_off(4).freeze());
		}
		Ok(frames)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn round_trips_frames() {
		let mut buffer = BytesMut::new();
		encode_frame(&mut buffer, b"one").expect("small frame");
		encode_frame(&mut buffer, b"").expect("empty frame");
		let mut decoder = FrameDecoder::default();
		let frames = decoder.push(&buffer).expect("decode");
		assert_eq!(frames.len(), 2);
		assert_eq!(&frames[0][..], b"one");
		assert!(frames[1].is_empty());
	}

	#[test]
	fn splits_and_joins_partial_frames() {
		let mut buffer = BytesMut::new();
		encode_frame(&mut buffer, &[7u8; 100]).expect("frame");
		let mut decoder = FrameDecoder::default();
		assert!(decoder.push(&buffer[..10]).expect("prefix").is_empty());
		let frames = decoder.push(&buffer[10..]).expect("suffix");
		assert_eq!(frames.len(), 1);
		assert_eq!(frames[0].len(), 100);
	}

	#[test]
	fn rejects_oversized_length() {
		let mut decoder = FrameDecoder::default();
		let oversized = (MAX_FRAME_BYTES + 1).to_be_bytes();
		let error = decoder.push(&oversized).expect_err("must reject");
		assert!(matches!(error, FrameError::Oversized(_)));
	}

	#[test]
	fn rejects_oversized_encode() {
		let mut buffer = BytesMut::new();
		let error = encode_frame(&mut buffer, &vec![0u8; (MAX_FRAME_BYTES + 1) as usize][..])
			.expect_err("must reject");
		assert!(matches!(error, FrameError::Oversized(_)));
	}
}
