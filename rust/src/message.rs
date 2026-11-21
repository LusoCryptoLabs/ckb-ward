//! The proof message: six lines a platform writes and the wallet signs (SPEC section 3).
use ckb_types::{packed, H256};

use crate::util::{hex, script_hash_hex};

/// Largest message, in UTF-8 bytes.
pub const MAX_MESSAGE_BYTES: usize = 1024;

const HEADER: &str = " wants you to prove control of a CKB lock.";

/// The six fields of a proof message, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageFields {
    /// Host of the platform asking for the proof, e.g. "dao.example".
    pub domain: String,
    /// The platform account the lock is being linked to.
    pub account: String,
    /// Script hash of the lock being proven: `0x` and 64 lowercase hex digits.
    pub lock_hash: String,
    /// Genesis block hash of the chain the lock lives on: `0x` and 64 lowercase hex digits.
    pub chain: String,
    /// RFC 3339 UTC time the platform issued the request, e.g. "2026-11-04T18:00:00Z".
    pub issued_at: String,
    /// Single use value chosen by the platform.
    pub nonce: String,
}

/// A message that does not fit the format. The text says which part.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageError(pub String);

impl std::fmt::Display for MessageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for MessageError {}

fn err<T>(s: &str) -> Result<T, MessageError> {
    Err(MessageError(s.to_string()))
}

const fn alnum(b: u8) -> bool {
    b.is_ascii_alphanumeric()
}

/// A host name or address, then an optional port of 1 to 5 digits.
fn domain_ok(s: &str) -> bool {
    let (host, port) = match s.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (s, None),
    };
    let h = host.as_bytes();
    let host_ok = !h.is_empty() && alnum(h[0]) && alnum(h[h.len() - 1]) && h.iter().all(|&b| alnum(b) || b == b'.' || b == b'-');
    let port_ok = port.is_none_or(|p| (1..=5).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()));
    host_ok && port_ok
}

/// Printable ASCII, 1 to 256 characters, no space at either end. Anything wider lets an account
/// name hide or reorder text where a wallet shows it.
fn account_ok(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=256).contains(&b.len()) && b.iter().all(|&c| (0x20..=0x7e).contains(&c)) && b[0] != b' ' && b[b.len() - 1] != b' '
}

fn hash_ok(s: &str) -> bool {
    s.len() == 66 && s.starts_with("0x") && s.as_bytes()[2..].iter().all(|&c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn nonce_ok(s: &str) -> bool {
    (1..=128).contains(&s.len()) && s.bytes().all(|c| alnum(c) || matches!(c, b'.' | b'_' | b'~' | b'-'))
}

/// Days from 1970-01-01 to the given civil date (proleptic Gregorian).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn days_in_month(y: i64, m: i64) -> i64 {
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][(m - 1) as usize]
}

/// Milliseconds since 1970 for `YYYY-MM-DDTHH:MM:SS[.f{1,9}]Z`, a time that exists (RFC 3339): the
/// month 1 to 12, the day inside its month (February 30 does not exist, and 1900 was not a leap
/// year), the hour 0 to 23, the minute and the second 0 to 59, and the fraction cut to milliseconds.
/// The TypeScript package refuses the same texts. None when the text is not that.
pub fn parse_time(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let digits = |r: std::ops::Range<usize>| -> Option<i64> {
        let part = b.get(r)?;
        if part.iter().all(u8::is_ascii_digit) {
            Some(part.iter().fold(0i64, |n, &c| n * 10 + i64::from(c - b'0')))
        } else {
            None
        }
    };
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || *b.last()? != b'Z' {
        return None;
    }
    let (y, mo, d, h, mi, sec) = (digits(0..4)?, digits(5..7)?, digits(8..10)?, digits(11..13)?, digits(14..16)?, digits(17..19)?);
    let ms = match &b[19..b.len() - 1] {
        [] => 0,
        [b'.', frac @ ..] if (1..=9).contains(&frac.len()) && frac.iter().all(u8::is_ascii_digit) => {
            let first3: Vec<u8> = frac.iter().copied().chain(std::iter::repeat(b'0')).take(3).collect();
            first3.iter().fold(0i64, |n, &c| n * 10 + i64::from(c - b'0'))
        }
        _ => return None,
    };
    if !(1..=12).contains(&mo) || d < 1 || d > days_in_month(y, mo) || h > 23 || mi > 59 || sec > 59 {
        return None;
    }
    Some(((days_from_civil(y, mo, 1) + d - 1) * 86_400 + h * 3600 + mi * 60 + sec) * 1000 + ms)
}

/// The time as JavaScript's `toISOString` writes it: `YYYY-MM-DDTHH:MM:SS.mmmZ`. For years 0 to 9999.
pub fn iso_time(unix_ms: i64) -> String {
    let days = unix_ms.div_euclid(86_400_000);
    let rest = unix_ms.rem_euclid(86_400_000);
    // civil_from_days
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rest / 3_600_000, rest / 60_000 % 60, rest / 1000 % 60, rest % 1000)
}

fn check(f: &MessageFields) -> Result<(), MessageError> {
    if !domain_ok(&f.domain) {
        return err("bad domain");
    }
    if !account_ok(&f.account) {
        return err("bad account");
    }
    if !hash_ok(&f.lock_hash) {
        return err("bad lock hash");
    }
    if !hash_ok(&f.chain) {
        return err("bad chain");
    }
    if parse_time(&f.issued_at).is_none() {
        return err("bad issued at");
    }
    if !nonce_ok(&f.nonce) {
        return err("bad nonce");
    }
    Ok(())
}

/// Builds the proof message for `lock`. `issued_at` is RFC 3339 UTC (see [`iso_time`]). Fails when a
/// field does not fit the format.
pub fn message(domain: &str, account: &str, lock: &packed::Script, chain: &H256, issued_at: &str, nonce: &str) -> Result<String, MessageError> {
    let f = MessageFields {
        domain: domain.into(),
        account: account.into(),
        lock_hash: script_hash_hex(lock),
        chain: hex(chain.as_bytes()),
        issued_at: issued_at.into(),
        nonce: nonce.into(),
    };
    check(&f)?;
    let text = format!(
        "{}{HEADER}\nAccount: {}\nLock hash: {}\nChain: {}\nIssued at: {}\nNonce: {}",
        f.domain, f.account, f.lock_hash, f.chain, f.issued_at, f.nonce
    );
    if text.len() > MAX_MESSAGE_BYTES {
        return err("message too long");
    }
    Ok(text)
}

/// Parses a proof message. Fails when the text is not exactly the format of [`message`].
pub fn parse_message(text: &str) -> Result<MessageFields, MessageError> {
    if text.len() > MAX_MESSAGE_BYTES {
        return err("message too long");
    }
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.len() != 6 {
        return err("expected 6 lines");
    }
    let take = |i: usize, prefix: &str| -> Result<String, MessageError> {
        lines[i].strip_prefix(prefix).map(str::to_string).ok_or_else(|| MessageError(format!("line {} must start with \"{prefix}\"", i + 1)))
    };
    let domain = lines[0].strip_suffix(HEADER).ok_or_else(|| MessageError("line 1 is not the header".into()))?;
    let f = MessageFields {
        domain: domain.into(),
        account: take(1, "Account: ")?,
        lock_hash: take(2, "Lock hash: ")?,
        chain: take(3, "Chain: ")?,
        issued_at: take(4, "Issued at: ")?,
        nonce: take(5, "Nonce: ")?,
    };
    check(&f)?;
    Ok(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_is_a_time_that_exists() {
        // Values printed by Node 24's Date.parse on 2026-11-21 where the time exists; None where RFC 3339 has no such time.
        let cases: &[(&str, Option<i64>)] = &[
            ("2026-11-04T18:00:00Z", Some(1793815200000)),
            ("2026-02-29T00:00:00Z", None),
            ("2024-02-29T00:00:00Z", Some(1709164800000)),
            ("2026-02-30T00:00:00Z", None),
            ("2026-02-31T00:00:00Z", None),
            ("2026-04-31T00:00:00Z", None),
            ("2026-04-30T23:59:59Z", Some(1777593599000)),
            ("2026-13-01T00:00:00Z", None),
            ("2026-00-01T00:00:00Z", None),
            ("2026-01-00T00:00:00Z", None),
            ("2026-01-32T00:00:00Z", None),
            ("2026-01-01T24:00:00Z", None),
            ("2026-01-01T24:00:01Z", None),
            ("2026-01-01T24:01:00Z", None),
            ("2026-01-01T23:60:00Z", None),
            ("2026-01-01T23:59:60Z", None),
            ("2026-01-01T25:00:00Z", None),
            ("2026-01-01T00:00:00.1Z", Some(1767225600100)),
            ("2026-01-01T00:00:00.12Z", Some(1767225600120)),
            ("2026-01-01T00:00:00.123Z", Some(1767225600123)),
            ("2026-01-01T00:00:00.1234Z", Some(1767225600123)),
            ("2026-01-01T00:00:00.123456789Z", Some(1767225600123)),
            ("2026-01-01T00:00:00.9999Z", Some(1767225600999)),
            ("0000-01-01T00:00:00Z", Some(-62167219200000)),
            ("9999-12-31T23:59:59.999Z", Some(253402300799999)),
            ("1900-02-29T00:00:00Z", None),
            ("1900-02-28T00:00:00Z", Some(-2203977600000)),
            ("2000-02-29T00:00:00Z", Some(951782400000)),
            ("2026-01-01T24:00:00.000Z", None),
            ("2026-01-01T24:00:00.5Z", None),
            ("2026-01-01T00:00:00.Z", None),
            ("2026-01-01T00:00:00.1234567890Z", None),
            ("2026-01-01 00:00:00Z", None),
            ("2026-01-01T00:00:00", None),
            ("2026-1-01T00:00:00Z", None),
        ];
        for (s, want) in cases {
            assert_eq!(parse_time(s), *want, "{s}");
        }
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1767225600123), "2026-01-01T00:00:00.123Z");
        assert_eq!(iso_time(-62167219200000), "0000-01-01T00:00:00.000Z");
    }

    #[test]
    fn fields_follow_the_format() {
        assert!(domain_ok("dao.example") && domain_ok("a") && domain_ok("localhost:5173") && domain_ok("1.2.3.4:1"));
        assert!(
            !domain_ok("")
                && !domain_ok("-a")
                && !domain_ok("a-")
                && !domain_ok("a:")
                && !domain_ok("a:123456")
                && !domain_ok("a:1:2")
                && !domain_ok("a b")
        );
        assert!(account_ok("user-42") && account_ok("a b") && account_ok(&"x".repeat(256)));
        assert!(
            !account_ok("")
                && !account_ok(" a")
                && !account_ok("a ")
                && !account_ok(&"x".repeat(257))
                && !account_ok("a\u{202e}b")
                && !account_ok("a\tb")
        );
        assert!(nonce_ok("abc-._~") && !nonce_ok("") && !nonce_ok("a b") && !nonce_ok(&"n".repeat(129)));
        assert!(hash_ok(&format!("0x{}", "a".repeat(64))) && !hash_ok(&format!("0x{}", "A".repeat(64))));
    }
}
