//! Gemini 原生格式适配器。
//! 端点：`{baseUrl}/v1beta/models/{model}:generateContent?key=KEY`、`{baseUrl}/v1beta/models?key=KEY`。

use async_trait::async_trait;
use serde_json::{json, Value};

use super::super::config::Connection;
use super::super::{AnalyzeRequest, AnalyzeResponse, LlmError, Usage};
use super::{extract_json, map_status, ChatAdapter};

pub struct GeminiAdapter;

fn base(conn: &Connection) -> String {
    let b = conn.base_url.trim_end_matches('/');
    if b.is_empty() {
        "https://generativelanguage.googleapis.com".to_string()
    } else {
        b.to_string()
    }
}

fn api_key(conn: &Connection) -> Result<String, LlmError> {
    conn.usable_key()
        .map(|k| k.key.trim().to_string())
        .filter(|k| !k.is_empty())
        .ok_or(LlmError::Auth)
}

#[async_trait]
impl ChatAdapter for GeminiAdapter {
    async fn call(
        &self,
        client: &reqwest::Client,
        conn: &Connection,
        model: &str,
        req: &AnalyzeRequest,
    ) -> Result<AnalyzeResponse, LlmError> {
        let key = api_key(conn)?;
        let url = format!("{}/v1beta/models/{}:generateContent?key={}", base(conn), model, key);

        let mut parts = vec![json!({ "text": req.user_text })];
        for img in &req.images {
            parts.push(json!({
                "inline_data": { "mime_type": img.mime, "data": img.base64 }
            }));
        }
        // 音频输入（Gemini 原生支持，可据此转写口播稿）
        for au in &req.audios {
            parts.push(json!({
                "inline_data": { "mime_type": au.mime, "data": au.base64 }
            }));
        }

        let mut body = json!({
            "system_instruction": { "parts": [ { "text": req.system } ] },
            "contents": [ { "role": "user", "parts": parts } ]
        });
        let mut gen_cfg = json!({});
        if let Some(schema) = &req.json_schema {
            gen_cfg["responseMimeType"] = json!("application/json");
            gen_cfg["responseSchema"] = schema.clone();
        }
        if let Some(mt) = req.max_tokens {
            gen_cfg["maxOutputTokens"] = json!(mt);
        }
        if gen_cfg.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
            body["generationConfig"] = gen_cfg;
        }

        let resp = client
            .post(&url)
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
        // 合并 candidates[0].content.parts[*].text
        let content = v["candidates"][0]["content"]["parts"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();
        let usage = Some(Usage {
            prompt_tokens: v["usageMetadata"]["promptTokenCount"].as_u64().map(|n| n as u32),
            completion_tokens: v["usageMetadata"]["candidatesTokenCount"]
                .as_u64()
                .map(|n| n as u32),
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
        let url = format!("{}/v1beta/models?key={}", base(conn), key);
        let resp = client
            .get(&url)
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
        let models = v["models"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m["name"].as_str())
                    .map(|s| s.trim_start_matches("models/").to_string())
                    .collect()
            })
            .unwrap_or_default();
        Ok(models)
    }
}
