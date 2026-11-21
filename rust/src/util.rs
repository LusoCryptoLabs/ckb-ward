//! Small helpers shared by the modules: hex in the JSON RPC form, and the hash of a script.
use ckb_types::{packed, prelude::*};

/// `0x` and lowercase hex.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

/// Parses `0x` and an even number of hex digits, either case.
pub fn unhex(s: &str) -> Result<Vec<u8>, String> {
    let digits = s.strip_prefix("0x").ok_or_else(|| format!("{s:?} does not start with 0x"))?;
    if digits.len() % 2 != 0 {
        return Err(format!("{s:?} has an odd number of hex digits"));
    }
    let value = |c: u8| match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => Err(format!("{s:?} is not hex")),
    };
    digits.as_bytes().chunks(2).map(|p| Ok(value(p[0])? << 4 | value(p[1])?)).collect()
}

/// A number in the JSON RPC form: `0x` and lowercase hex with no leading zeros.
pub fn hex_num(n: u64) -> String {
    format!("{n:#x}")
}

/// The lock hash as the message writes it: `0x` and 64 lowercase hex digits.
pub fn script_hash_hex(script: &packed::Script) -> String {
    hex(script.calc_script_hash().as_slice())
}

/// 32 bytes from `0x` and 64 hex digits.
pub fn byte32(s: &str) -> Result<packed::Byte32, String> {
    let b = unhex(s)?;
    if b.len() != 32 {
        return Err(format!("{s:?} is not 32 bytes"));
    }
    Ok(packed::Byte32::from_slice(&b).expect("32 bytes"))
}
