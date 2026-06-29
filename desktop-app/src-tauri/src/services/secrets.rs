//! 凭据（API key）的安全边界工具。
//!
//! 规范：明文 key 只在后端 `services` 内流转，绝不经 IPC 传给前端、绝不进 webview。
//! 前端只看得到 `mask()` 后的掩码串。

/// 把密钥掩码成可安全展示的形式，保留前缀与末尾 4 位。
/// 例："AIzaSyD...wxyz" → "AIza••••wxyz"；"sk-or-v1-abcd...wxyz" → "sk-or••••wxyz"
pub fn mask(key: &str) -> String {
    let key = key.trim();
    if key.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = key.chars().collect();
    let n = chars.len();
    if n <= 8 {
        // 太短，只露前 1 位
        let head: String = chars.iter().take(1).collect();
        return format!("{head}••••");
    }
    let head: String = chars.iter().take(4).collect();
    let tail: String = chars.iter().skip(n - 4).collect();
    format!("{head}••••{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_basic() {
        assert_eq!(mask("AIzaSyD1234wxyz"), "AIza••••wxyz");
        assert_eq!(mask(""), "");
        assert_eq!(mask("short"), "s••••");
    }
}
