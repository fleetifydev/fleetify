//! Shortening text without splitting a character.
//!
//! `String::truncate(n)` and `&s[..n]` take a byte index and panic when it
//! falls inside a multi-byte character. Turkish letters (ş ı ğ ü ö ç) are two
//! bytes each and emoji four, so a byte cut on user- or model-supplied text
//! crashes as soon as that text is not ASCII. These helpers always cut on a
//! character boundary.

/// Keep at most `max_chars` characters (Unicode scalar values) of `s`.
///
/// For limits stated in characters, such as the 72-character commit subject.
/// Text that is already short enough is left untouched.
pub fn truncate_chars(s: &mut String, max_chars: usize) {
    if let Some((cut, _)) = s.char_indices().nth(max_chars) {
        s.truncate(cut);
    }
}

/// The longest prefix of `s` that is at most `max_bytes` bytes long and ends
/// on a character boundary.
///
/// For limits stated in bytes, such as a log-line budget: a cut that lands
/// inside a character backs off to the start of that character, so the
/// prefix can come out up to three bytes shorter than `max_bytes`.
pub fn prefix_within_bytes(s: &str, max_bytes: usize) -> &str {
    // Stable since Rust 1.91; returns `s.len()` when `max_bytes` is past the end.
    &s[..s.floor_char_boundary(max_bytes)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_chars_cuts_turkish_text_to_72_characters() {
        let mut s = format!("{}şğ", "a".repeat(71));
        truncate_chars(&mut s, 72);
        assert_eq!(s.chars().count(), 72);
        assert!(s.ends_with('ş'), "last kept character is ş: {s:?}");
    }

    #[test]
    fn truncate_chars_leaves_short_text_unchanged() {
        let mut s = "kısa metin".to_string();
        assert_eq!(s.chars().count(), 10);
        truncate_chars(&mut s, 72);
        assert_eq!(s, "kısa metin");
    }

    #[test]
    fn truncate_chars_keeps_whole_emoji() {
        let mut s = "👍".repeat(80);
        truncate_chars(&mut s, 72);
        assert_eq!(s.chars().count(), 72);
        // 72 whole four-byte emoji: no partial character survives the cut.
        assert_eq!(s.len(), 72 * 4);
        assert_eq!(s, "👍".repeat(72));
    }

    #[test]
    fn prefix_within_bytes_backs_off_to_the_previous_boundary() {
        // "ş" is two bytes, so the boundaries are 0, 1 and 3.
        assert_eq!(prefix_within_bytes("aş", 2), "a");
    }

    #[test]
    fn prefix_within_bytes_keeps_a_cut_that_is_already_a_boundary() {
        let s = "ı".repeat(1500); // two bytes each
        assert_eq!(s.len(), 3000);
        assert_eq!(prefix_within_bytes(&s, 2048).len(), 2048);
        assert_eq!(prefix_within_bytes(&s, 2047).len(), 2046);
    }

    #[test]
    fn prefix_within_bytes_leaves_short_ascii_unchanged() {
        assert_eq!(prefix_within_bytes("hello", 2048), "hello");
    }
}
