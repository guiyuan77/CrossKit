//! OpenAI 兼容格式适配器（覆盖 OpenAI / OpenRouter / DeepSeek / 国产多数 / 本地 LM Studio·Ollama）。
//! 端点：`{baseUrl}/chat/completions`、`{baseUrl}/models`。

use async_trait::async_trait;
use serde_json::{json, Value};

use super::super::config::Connection;
use super::super::{AnalyzeRequest, AnalyzeResponse, LlmError, Usage};
use super::{extract_json, map_status, ChatAdapter};

pub struct OpenAiAdapter;

fn base(conn: &Connection) -> String {
    conn.base_url.trim_end_matches('/').to_string()
}

fn api_key(conn: &Connection) -> Result<String, LlmError> {
    conn.usable_key()
        .map(|k| k.key.trim().to_string())
        .filter(|k| !k.is_empty())
        .ok_or(LlmError::Auth)
}

#[async_trait]
impl ChatAdapter for OpenAiAdapter {
    async fn call(
        &self,
        client: &reqwest::Client,
        conn: &Connection,
        model: &str,
        req: &AnalyzeRequest,
    ) -> Result<AnalyzeResponse, LlmError> {
        let key = api_key(conn)?;
        let url = format!("{}/chat/completions", base(conn));

        // 注意：OpenAI chat/completions 不通吃原始音频输入，故忽略 `req.audios`（厂商能力差异降级）。
        // user content：纯文本或 文本+图片 多模态数组
        let user_content: Value = if req.images.is_empty() {
            json!(req.user_text)
        } else {
            let mut parts = vec![json!({ "type": "text", "text": req.user_text })];
            for img in &req.images {
                parts.push(json!({
                    "type": "image_url",
                    "image_url": { "url": format!("data:{};base64,{}", img.mime, img.base64) }
                }));
            }
            json!(parts)
        };

        let mut body = json!({
            "model": model,
            "messages": [
                { "role": "system", "content": req.system },
                { "role": "user", "content": user_content }
            ]
        });
        if req.json_schema.is_some() {
            body["response_format"] = json!({ "type": "json_object" });
        }
        if let Some(mt) = req.max_tokens {
            body["max_tokens"] = json!(mt);
        }

        let resp = client
            .post(&url)
            .bearer_auth(&key)
            .json(&body)
            .send()
            .await
            .map_err(|e| LlmError::Network(e.to_string()))?;

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(map_status(status, &text));
        }

        let v: Value = serde_json::from_str(&text)
            .map_err(|e| LlmError::BadResponse(format!("解析响应失败：{e}")))?;
        let content = v["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let usage = Some(Usage {
            prompt_tokens: v["usage"]["prompt_tokens"].as_u64().map(|n| n as u32),
            completion_tokens: v["usage"]["completion_tokens"].as_u64().map(|n| n as u32),
        });
        let json = if req.json_schema.is_some() {
            extract_json(&content)
        } else {
            None
        };
        Ok(AnalyzeResponse {
            text: content,
            json,
            usage,
        })
    }

    async fn list_models(
        &self,
        client: &reqwest::Client,
        conn: &Connection,
    ) -> Result<Vec<String>, LlmError> {
        let key = api_key(conn)?;
        let url = format!("{}/models", base(conn));
        let resp = client
            .get(&url)
            .bearer_auth(&key)
            .send()
            .await
            .map_err(|e| LlmError::Network(e.to_string()))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(map_status(status, &text));
        }
        let v: Value = serde_json::from_str(&text)
            .map_err(|e| LlmError::BadResponse(format!("解析模型列表失败：{e}")))?;
        let models = v["data"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        Ok(models)
    }
}
