//! TOML literal emitters for Codex CLI `-c <key>=<value>` args.
//! Mirrors `_toml_quote` / `_toml_inline_table` / `_toml_inline_array`
//! from the Python codex_bridge — keeps the exact same escape rules so
//! that round-tripping registry entries (including headers with quotes
//! or backslashes) match the wire format Codex expects.

pub fn quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

pub fn inline_table<I, K, V>(pairs: I) -> String
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
    V: AsRef<str>,
{
    let parts: Vec<String> = pairs
        .into_iter()
        .map(|(k, v)| format!("{} = {}", quote(k.as_ref()), quote(v.as_ref())))
        .collect();
    format!("{{ {} }}", parts.join(", "))
}

pub fn inline_array<I, S>(items: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let parts: Vec<String> = items
        .into_iter()
        .map(|s| quote(s.as_ref()))
        .collect();
    format!("[{}]", parts.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_escapes_backslash_and_double_quote() {
        assert_eq!(quote("hello"), "\"hello\"");
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote("a\\b"), "\"a\\\\b\"");
        // Order matters: backslash first, then quote — otherwise
        // the quote-escape's `\\` would be re-escaped by the backslash pass.
        assert_eq!(quote("\\\""), "\"\\\\\\\"\"");
    }

    #[test]
    fn inline_table_preserves_pair_order_and_escapes() {
        let s = inline_table([("Authorization", "Bearer abc"), ("X-Y", "v")]);
        assert_eq!(s, "{ \"Authorization\" = \"Bearer abc\", \"X-Y\" = \"v\" }");
    }

    #[test]
    fn inline_table_escapes_values_with_quotes() {
        let s = inline_table([("k", "v\"x")]);
        assert_eq!(s, "{ \"k\" = \"v\\\"x\" }");
    }

    #[test]
    fn inline_array_quotes_each_item() {
        let s = inline_array(["a", "b", "c"]);
        assert_eq!(s, "[\"a\", \"b\", \"c\"]");
    }

    #[test]
    fn inline_array_escapes_items() {
        let s = inline_array(["a\\b", "c\"d"]);
        assert_eq!(s, "[\"a\\\\b\", \"c\\\"d\"]");
    }
}
