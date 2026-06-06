//! Static registry of Studio (media-generation) tools. Separate from the
//! conversational provider CATALOG. Higgsfield is the first entry.
use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct StudioTool {
    pub id: &'static str,
    pub display_name: &'static str,
    pub bin: &'static str,
    pub install_hint: &'static str,
    pub media: &'static [&'static str],
}

pub static STUDIO_TOOLS: &[StudioTool] = &[StudioTool {
    id: "higgsfield",
    display_name: "Higgsfield",
    bin: "hf",
    install_hint: "npm install -g @higgsfield/cli",
    media: &["image", "video"],
}];

pub fn find_studio_tool(id: &str) -> Option<&'static StudioTool> {
    STUDIO_TOOLS.iter().find(|t| t.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn higgsfield_registered() {
        let hf = find_studio_tool("higgsfield").expect("higgsfield present");
        assert_eq!(hf.display_name, "Higgsfield");
        assert_eq!(hf.bin, "hf");
        assert!(hf.install_hint.contains("@higgsfield/cli"));
        assert!(hf.media.contains(&"image") && hf.media.contains(&"video"));
    }
    #[test]
    fn unknown_tool_is_none() {
        assert!(find_studio_tool("nope").is_none());
    }
}
