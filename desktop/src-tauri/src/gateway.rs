use crate::app_state::{
    GatewayParsedResult, LatestGatewayTarget, RequestType, WordDetailComparison, WordDetailResult,
};
use reqwest::blocking::{Client, RequestBuilder};
use reqwest::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

pub const GATEWAY_BASE_URL: &str =
    "https://translator-gateway-beta-268073468344.asia-northeast1.run.app";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RAW_PREVIEW_LIMIT: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    Timeout,
    Network,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

pub trait GatewayTransport: Send + Sync {
    fn post(
        &self,
        path: &str,
        access_token: &str,
        json_body: Option<&str>,
    ) -> Result<HttpResponse, TransportError>;
}

pub struct ReqwestGatewayTransport {
    client: Client,
}

impl ReqwestGatewayTransport {
    pub fn new() -> Result<Self, GatewayFailure> {
        Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map(|client| Self { client })
            .map_err(|_| GatewayFailure::network())
    }
}

fn apply_post_payload(request: RequestBuilder, json_body: Option<&str>) -> RequestBuilder {
    match json_body {
        Some(body) => request
            .header(CONTENT_TYPE, "application/json")
            .body(body.to_owned()),
        None => request.header(CONTENT_LENGTH, "0"),
    }
}

impl GatewayTransport for ReqwestGatewayTransport {
    fn post(
        &self,
        path: &str,
        access_token: &str,
        json_body: Option<&str>,
    ) -> Result<HttpResponse, TransportError> {
        let request = self
            .client
            .post(format!("{GATEWAY_BASE_URL}{path}"))
            .header(AUTHORIZATION, format!("Bearer {access_token}"));
        let response = apply_post_payload(request, json_body)
            .send()
            .map_err(|error| {
                if error.is_timeout() {
                    TransportError::Timeout
                } else {
                    TransportError::Network
                }
            })?;
        let status = response.status().as_u16();
        let body = response.text().map_err(|_| TransportError::Network)?;
        Ok(HttpResponse { status, body })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageRequest {
    pub request_id: String,
    pub request_type: RequestType,
    pub analysis_mode: &'static str,
    pub source_language: &'static str,
    pub target_language: &'static str,
    pub text: String,
    pub context_sentence: String,
    pub page_title: String,
    pub mode: crate::settings::TranslationMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayFailure {
    pub error_code: String,
    pub gateway_error_code: Option<String>,
    pub message: String,
    pub http_status: Option<u16>,
    pub requires_configuration: bool,
    pub parse_failed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_preview: Option<String>,
}

impl GatewayFailure {
    fn new(code: &str, message: &str) -> Self {
        Self {
            error_code: code.into(),
            gateway_error_code: None,
            message: message.into(),
            http_status: None,
            requires_configuration: false,
            parse_failed: false,
            raw_preview: None,
        }
    }

    fn timeout() -> Self {
        Self::new("timeout", "Gateway 请求超时")
    }

    fn network() -> Self {
        Self::new("network_error", "无法连接 Gateway")
    }

    fn parse(code: &str, message: &str, body: &str, status: Option<u16>) -> Self {
        let mut failure = Self::new(code, message);
        failure.http_status = status;
        failure.parse_failed = true;
        failure.raw_preview = Some(bounded_preview(body));
        failure
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResult {
    pub access: String,
    pub http_status: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VerifyEnvelope {
    status: String,
    access: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SuccessEnvelope {
    status: String,
    request_id: String,
    data: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEnvelope {
    status: String,
    error_code: String,
    message: String,
    #[serde(default)]
    requires_configuration: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WordQuickData {
    provider: String,
    upstream_provider: String,
    result_type: String,
    skill_version: String,
    analysis_mode: String,
    analysis: WordQuickAnalysis,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WordQuickAnalysis {
    word: String,
    lemma: String,
    phonetic: String,
    part_of_speech: String,
    meaning: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WordDetailData {
    provider: String,
    upstream_provider: String,
    result_type: String,
    skill_version: String,
    analysis_mode: String,
    analysis: WordDetailAnalysis,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WordDetailAnalysis {
    meaning_in_sentence: String,
    comparison: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WordComparisonData {
    word: String,
    difference: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SentenceData {
    provider: String,
    upstream_provider: String,
    result_type: String,
    skill_version: String,
    translation: String,
    key_term: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyTerm {
    term: String,
    meaning: String,
}

pub struct GatewayClient<T> {
    transport: T,
}

impl<T: GatewayTransport> GatewayClient<T> {
    pub fn new(transport: T) -> Self {
        Self { transport }
    }

    pub fn verify_access_code(
        &self,
        access_token: &str,
    ) -> Result<VerificationResult, GatewayFailure> {
        let response = self
            .transport
            .post("/v1/auth/verify", access_token, None)
            .map_err(map_transport_error)?;
        if !(200..300).contains(&response.status) {
            return Err(parse_http_error(response.status, &response.body));
        }
        let envelope: VerifyEnvelope = serde_json::from_str(&response.body).map_err(|_| {
            GatewayFailure::parse(
                "response_json_invalid",
                "访问码验证响应不是合法 JSON",
                &response.body,
                Some(response.status),
            )
        })?;
        if envelope.status != "ok" || envelope.access != "granted" {
            return Err(GatewayFailure::parse(
                "response_schema_invalid",
                "访问码验证响应不符合协议",
                &response.body,
                Some(response.status),
            ));
        }
        Ok(VerificationResult {
            access: envelope.access,
            http_status: response.status,
        })
    }

    pub fn send_language(
        &self,
        access_token: &str,
        request: &LanguageRequest,
    ) -> Result<(u16, GatewayParsedResult), GatewayFailure> {
        self.send_language_observed(access_token, request, |_| {})
    }

    pub fn send_language_observed(
        &self, access_token: &str, request: &LanguageRequest,
        observe_parse_ms: impl FnOnce(u64),
    ) -> Result<(u16, GatewayParsedResult), GatewayFailure> {
        let (response, data) = self.send_language_envelope(access_token, request)?;
        let started = std::time::Instant::now();
        let parsed = parse_data(request.request_type, data, &response.body, response.status);
        observe_parse_ms(started.elapsed().as_millis() as u64);
        let parsed = parsed?;
        Ok((response.status, parsed))
    }

    pub fn send_word_detail(
        &self,
        access_token: &str,
        request: &LanguageRequest,
    ) -> Result<(u16, WordDetailResult), GatewayFailure> {
        let (response, data) = self.send_language_envelope(access_token, request)?;
        let parsed = parse_detail_data(data, &response.body, response.status)?;
        Ok((response.status, parsed))
    }

    fn send_language_envelope(
        &self,
        access_token: &str,
        request: &LanguageRequest,
    ) -> Result<(HttpResponse, Value), GatewayFailure> {
        let body = serde_json::to_string(request)
            .map_err(|_| GatewayFailure::new("response_schema_invalid", "无法构造 Gateway 请求"))?;
        let response = self
            .transport
            .post("/v1/language", access_token, Some(&body))
            .map_err(map_transport_error)?;
        if !(200..300).contains(&response.status) {
            return Err(parse_http_error(response.status, &response.body));
        }
        let envelope: SuccessEnvelope = serde_json::from_str(&response.body).map_err(|_| {
            GatewayFailure::parse(
                "response_json_invalid",
                "Gateway 响应不是合法 JSON",
                &response.body,
                Some(response.status),
            )
        })?;
        if envelope.status != "ok" {
            return Err(GatewayFailure::parse(
                "response_schema_invalid",
                "Gateway 成功响应 status 非 ok",
                &response.body,
                Some(response.status),
            ));
        }
        if envelope.request_id != request.request_id {
            return Err(GatewayFailure::parse(
                "request_id_mismatch",
                "Gateway 响应 requestId 不匹配",
                &response.body,
                Some(response.status),
            ));
        }
        Ok((response, envelope.data))
    }
}

pub fn build_language_request(
    target: &LatestGatewayTarget,
    request_id: String,
) -> Result<LanguageRequest, GatewayFailure> {
    let target_length = target.target.chars().count();
    if target_length == 0 || target_length > 5000 {
        return Err(GatewayFailure::new(
            "response_schema_invalid",
            "TARGET 长度不符合 Gateway 协议",
        ));
    }
    Ok(LanguageRequest {
        request_id,
        request_type: target.request_type,
        analysis_mode: "quick",
        source_language: "en",
        target_language: "zh-CN",
        text: target.target.clone(),
        context_sentence: target.context.context_sentence.chars().take(5000).collect(),
        page_title: target.page_title.chars().take(300).collect(),
        mode: target.translation_mode,
    })
}

pub fn build_detail_language_request(
    target: &LatestGatewayTarget,
    request_id: String,
) -> Result<LanguageRequest, GatewayFailure> {
    if target.request_type != RequestType::WordAnalysis {
        return Err(GatewayFailure::new(
            "response_schema_invalid",
            "Detail 仅支持 Word Analysis",
        ));
    }
    let mut request = build_language_request(target, request_id)?;
    request.analysis_mode = "detail";
    Ok(request)
}

fn parse_detail_data(
    data: Value,
    body: &str,
    status: u16,
) -> Result<WordDetailResult, GatewayFailure> {
    let detail: WordDetailData = serde_json::from_value(data).map_err(|_| {
        GatewayFailure::parse(
            "response_schema_invalid",
            "Detail 响应结构不符合协议",
            body,
            Some(status),
        )
    })?;
    if detail.provider != "gateway"
        || detail.upstream_provider.trim().is_empty()
        || detail.result_type != "contextAnalysis"
        || detail.skill_version.trim().is_empty()
        || detail.analysis_mode != "detail"
        || detail.analysis.meaning_in_sentence.trim().is_empty()
    {
        return Err(GatewayFailure::parse(
            "response_schema_invalid",
            "Detail 响应字段不符合协议",
            body,
            Some(status),
        ));
    }
    let comparison = if detail.analysis.comparison.is_null() {
        None
    } else {
        let comparison: WordComparisonData = serde_json::from_value(detail.analysis.comparison)
            .map_err(|_| {
                GatewayFailure::parse(
                    "response_schema_invalid",
                    "Detail comparison 不符合协议",
                    body,
                    Some(status),
                )
            })?;
        if comparison.word.trim().is_empty() || comparison.difference.trim().is_empty() {
            return Err(GatewayFailure::parse(
                "response_schema_invalid",
                "Detail comparison 字段为空",
                body,
                Some(status),
            ));
        }
        Some(WordDetailComparison {
            word: comparison.word,
            difference: comparison.difference,
        })
    };
    Ok(WordDetailResult {
        meaning_in_sentence: detail.analysis.meaning_in_sentence,
        comparison,
    })
}

fn parse_data(
    request_type: RequestType,
    data: Value,
    body: &str,
    status: u16,
) -> Result<GatewayParsedResult, GatewayFailure> {
    match request_type {
        RequestType::WordAnalysis => {
            let word: WordQuickData = serde_json::from_value(data).map_err(|_| {
                GatewayFailure::parse(
                    "response_schema_invalid",
                    "Word 响应结构不符合协议",
                    body,
                    Some(status),
                )
            })?;
            let valid_part = matches!(
                word.analysis.part_of_speech.as_str(),
                "adj." | "v." | "n." | "adv." | "prep." | "phr."
            );
            if word.provider != "gateway"
                || word.upstream_provider.trim().is_empty()
                || word.result_type != "contextAnalysis"
                || word.skill_version.trim().is_empty()
                || word.analysis_mode != "quick"
                || word.analysis.word.trim().is_empty()
                || word.analysis.lemma.trim().is_empty()
                || word.analysis.phonetic.trim().is_empty()
                || !valid_part
                || word.analysis.meaning.trim().is_empty()
            {
                return Err(GatewayFailure::parse(
                    "response_schema_invalid",
                    "Word 响应字段不符合协议",
                    body,
                    Some(status),
                ));
            }
            Ok(GatewayParsedResult::Word {
                provider: word.provider,
                upstream_provider: word.upstream_provider,
                skill_version: word.skill_version,
                word: word.analysis.word,
                lemma: word.analysis.lemma,
                phonetic: word.analysis.phonetic,
                part_of_speech: word.analysis.part_of_speech,
                meaning: word.analysis.meaning,
            })
        }
        RequestType::SentenceTranslation => {
            let sentence: SentenceData = serde_json::from_value(data).map_err(|_| {
                GatewayFailure::parse(
                    "response_schema_invalid",
                    "Sentence 响应结构不符合协议",
                    body,
                    Some(status),
                )
            })?;
            let key_term = if sentence.key_term.is_null() {
                None
            } else {
                Some(
                    serde_json::from_value::<KeyTerm>(sentence.key_term).map_err(|_| {
                        GatewayFailure::parse(
                            "response_schema_invalid",
                            "Sentence 关键术语结构不符合协议",
                            body,
                            Some(status),
                        )
                    })?,
                )
            };
            let key_term_valid = key_term.as_ref().is_none_or(|key_term| {
                !key_term.term.trim().is_empty()
                    && !key_term.meaning.trim().is_empty()
                    && !contains_markdown(&key_term.term)
                    && !contains_markdown(&key_term.meaning)
            });
            if sentence.provider != "gateway"
                || sentence.upstream_provider.trim().is_empty()
                || sentence.result_type != "sentenceTranslation"
                || sentence.skill_version.trim().is_empty()
                || sentence.translation.trim().is_empty()
                || contains_markdown(&sentence.translation)
                || !key_term_valid
            {
                return Err(GatewayFailure::parse(
                    "response_schema_invalid",
                    "Sentence 响应字段不符合协议",
                    body,
                    Some(status),
                ));
            }
            Ok(GatewayParsedResult::Sentence {
                provider: sentence.provider,
                upstream_provider: sentence.upstream_provider,
                skill_version: sentence.skill_version,
                translation: sentence.translation,
                key_term: key_term.map(|key_term| crate::app_state::GatewayKeyTerm {
                    term: key_term.term,
                    meaning: key_term.meaning,
                }),
            })
        }
    }
}

fn map_transport_error(error: TransportError) -> GatewayFailure {
    match error {
        TransportError::Timeout => GatewayFailure::timeout(),
        TransportError::Network => GatewayFailure::network(),
    }
}

fn parse_http_error(status: u16, body: &str) -> GatewayFailure {
    if let Ok(error) = serde_json::from_str::<ErrorEnvelope>(body) {
        if error.status == "error" {
            return GatewayFailure {
                error_code: match status {
                    401 | 403 => "invalid_access_token",
                    400..=499 => "http_4xx",
                    500..=599 => "http_5xx",
                    _ => "gateway_error",
                }
                .into(),
                gateway_error_code: Some(error.error_code),
                message: error.message,
                http_status: Some(status),
                requires_configuration: error.requires_configuration,
                parse_failed: false,
                raw_preview: None,
            };
        }
    }
    let code = match status {
        401 | 403 => "invalid_access_token",
        400..=499 => "http_4xx",
        500..=599 => "http_5xx",
        _ => "gateway_error",
    };
    let mut failure = GatewayFailure::new(code, "Gateway 返回 HTTP 错误");
    failure.http_status = Some(status);
    failure
}

fn bounded_preview(text: &str) -> String {
    let count = text.chars().count();
    if count <= RAW_PREVIEW_LIMIT {
        text.to_owned()
    } else {
        let mut preview: String = text.chars().take(RAW_PREVIEW_LIMIT - 1).collect();
        preview.push('…');
        preview
    }
}

fn contains_markdown(value: &str) -> bool {
    if value.contains("```") || has_wrapped_marker(value, "`") || has_wrapped_marker(value, "**") {
        return true;
    }
    value.lines().any(|line| {
        let trimmed = line.trim_start();
        if trimmed.starts_with("- ") || trimmed.starts_with("* ") || trimmed.starts_with("+ ") {
            return true;
        }
        let hashes = trimmed
            .chars()
            .take_while(|character| *character == '#')
            .count();
        (1..=6).contains(&hashes) && trimmed.chars().nth(hashes) == Some(' ')
    })
}

fn has_wrapped_marker(value: &str, marker: &str) -> bool {
    let Some(start) = value.find(marker) else {
        return false;
    };
    let content_start = start + marker.len();
    value[content_start..]
        .find(marker)
        .is_some_and(|end| end > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::{ContextCaptureSnapshot, ContextStatus, LatestGatewayTarget};
    use std::sync::Mutex;

    struct FakeTransport {
        response: Result<HttpResponse, TransportError>,
        request: Mutex<Option<(String, String, Option<String>)>>,
    }

    impl FakeTransport {
        fn response(status: u16, body: &str) -> Self {
            Self {
                response: Ok(HttpResponse {
                    status,
                    body: body.into(),
                }),
                request: Mutex::new(None),
            }
        }
    }

    impl GatewayTransport for FakeTransport {
        fn post(
            &self,
            path: &str,
            access_token: &str,
            json_body: Option<&str>,
        ) -> Result<HttpResponse, TransportError> {
            *self.request.lock().unwrap() = Some((
                path.into(),
                access_token.into(),
                json_body.map(str::to_owned),
            ));
            self.response.clone()
        }
    }

    fn target(request_type: RequestType) -> LatestGatewayTarget {
        LatestGatewayTarget {
            target: "sample".into(),
            binding: None,
            request_type,
            page_title: "Notepad".into(),
            source_app: "Notepad".into(),
            capture_generation: 7,
            translation_generation: 8,
            captured_at_unix_ms: 9,
            context: ContextCaptureSnapshot::empty(ContextStatus::Unsupported),
            translation_mode: crate::settings::TranslationMode::Precise,
        }
    }

    #[test]
    fn empty_post_explicitly_sets_zero_content_length_without_a_body() {
        let request = apply_post_payload(Client::new().post("http://localhost/verify"), None)
            .build()
            .unwrap();

        assert_eq!(request.headers().get(CONTENT_LENGTH).unwrap(), "0");
        assert!(!request.headers().contains_key(CONTENT_TYPE));
        assert!(request.body().is_none());
    }

    #[test]
    fn json_post_preserves_content_type_and_body_without_manual_length() {
        let body = r#"{"requestId":"desktop-1"}"#;
        let request =
            apply_post_payload(Client::new().post("http://localhost/language"), Some(body))
                .build()
                .unwrap();

        assert_eq!(
            request.headers().get(CONTENT_TYPE).unwrap(),
            "application/json"
        );
        assert!(!request.headers().contains_key(CONTENT_LENGTH));
        assert_eq!(
            request.body().and_then(|value| value.as_bytes()),
            Some(body.as_bytes())
        );
    }

    #[test]
    fn request_matches_gateway_field_whitelist() {
        let request =
            build_language_request(&target(RequestType::WordAnalysis), "desktop-1".into()).unwrap();
        let value = serde_json::to_value(request).unwrap();
        let keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
        assert_eq!(
            keys,
            vec![
                "analysisMode",
                "contextSentence",
                "mode",
                "pageTitle",
                "requestId",
                "requestType",
                "sourceLanguage",
                "targetLanguage",
                "text"
            ]
        );
        assert_eq!(value["analysisMode"], "quick");
        assert_eq!(value["mode"], "precise");
        assert_eq!(value["contextSentence"], "");
        assert_eq!(value["sourceLanguage"], "en");
        assert_eq!(value["targetLanguage"], "zh-CN");
    }

    #[test]
    fn verifies_access_and_keeps_token_out_of_body() {
        let transport = FakeTransport::response(200, r#"{"status":"ok","access":"granted"}"#);
        let client = GatewayClient::new(transport);
        assert_eq!(
            client.verify_access_code("secret").unwrap().access,
            "granted"
        );
        let request = client.transport.request.lock().unwrap().clone().unwrap();
        assert_eq!(request.0, "/v1/auth/verify");
        assert_eq!(request.1, "secret");
        assert_eq!(request.2, None);
    }

    #[test]
    fn parses_strict_word_and_sentence_success() {
        let word_body = r#"{"status":"ok","requestId":"desktop-1","data":{"provider":"gateway","upstreamProvider":"gemini","resultType":"contextAnalysis","skillVersion":"context-analysis-v6","analysisMode":"quick","analysis":{"word":"sample","lemma":"sample","phonetic":"/sample/","partOfSpeech":"n.","meaning":"示例"}}}"#;
        let client = GatewayClient::new(FakeTransport::response(200, word_body));
        let request =
            build_language_request(&target(RequestType::WordAnalysis), "desktop-1".into()).unwrap();
        assert!(matches!(
            client.send_language("token", &request).unwrap().1,
            GatewayParsedResult::Word { .. }
        ));

        let sentence_body = r#"{"status":"ok","requestId":"desktop-2","data":{"provider":"gateway","upstreamProvider":"gemini","resultType":"sentenceTranslation","skillVersion":"sentence-translation-v1.1","translation":"这是示例。","keyTerm":{"term":"sample","meaning":"示例"}}}"#;
        let client = GatewayClient::new(FakeTransport::response(200, sentence_body));
        let request = build_language_request(
            &target(RequestType::SentenceTranslation),
            "desktop-2".into(),
        )
        .unwrap();
        assert!(matches!(
            client.send_language("token", &request).unwrap().1,
            GatewayParsedResult::Sentence { .. }
        ));
    }

    #[test]
    fn rejects_mismatch_invalid_schema_and_bounds_raw_preview() {
        let mismatch = r#"{"status":"ok","requestId":"other","data":{}}"#;
        let client = GatewayClient::new(FakeTransport::response(200, mismatch));
        let request =
            build_language_request(&target(RequestType::WordAnalysis), "desktop-1".into()).unwrap();
        assert_eq!(
            client
                .send_language("token", &request)
                .unwrap_err()
                .error_code,
            "request_id_mismatch"
        );

        let bad = format!("{{broken{}", "文".repeat(1200));
        let client = GatewayClient::new(FakeTransport::response(200, &bad));
        let failure = client.send_language("token", &request).unwrap_err();
        assert_eq!(failure.error_code, "response_json_invalid");
        assert_eq!(
            failure.raw_preview.unwrap().chars().count(),
            RAW_PREVIEW_LIMIT
        );
    }

    #[test]
    fn classifies_transport_and_http_failures() {
        let timeout = GatewayClient::new(FakeTransport {
            response: Err(TransportError::Timeout),
            request: Mutex::new(None),
        });
        assert_eq!(
            timeout.verify_access_code("x").unwrap_err().error_code,
            "timeout"
        );

        let unauthorized = GatewayClient::new(FakeTransport::response(
            401,
            r#"{"status":"error","errorCode":"INVALID_ACCESS_TOKEN","message":"invalid","requiresConfiguration":true}"#,
        ));
        let failure = unauthorized.verify_access_code("x").unwrap_err();
        assert_eq!(failure.error_code, "invalid_access_token");
        assert!(failure.requires_configuration);

        let network = GatewayClient::new(FakeTransport {
            response: Err(TransportError::Network),
            request: Mutex::new(None),
        });
        assert_eq!(
            network.verify_access_code("x").unwrap_err().error_code,
            "network_error"
        );

        for (status, expected) in [
            (403, "invalid_access_token"),
            (422, "http_4xx"),
            (503, "http_5xx"),
        ] {
            let client = GatewayClient::new(FakeTransport::response(
                status,
                r#"{"status":"error","errorCode":"UPSTREAM_CODE","message":"failed","requiresConfiguration":false}"#,
            ));
            let failure = client.verify_access_code("x").unwrap_err();
            assert_eq!(failure.error_code, expected);
            assert_eq!(failure.gateway_error_code.as_deref(), Some("UPSTREAM_CODE"));
        }
    }

    #[test]
    fn sentence_requires_key_term_field_and_rejects_markdown() {
        let request = build_language_request(
            &target(RequestType::SentenceTranslation),
            "desktop-2".into(),
        )
        .unwrap();
        let missing_key_term = r#"{"status":"ok","requestId":"desktop-2","data":{"provider":"gateway","upstreamProvider":"gemini","resultType":"sentenceTranslation","skillVersion":"sentence-translation-v1.1","translation":"有效译文"}}"#;
        let client = GatewayClient::new(FakeTransport::response(200, missing_key_term));
        assert_eq!(
            client
                .send_language("token", &request)
                .unwrap_err()
                .error_code,
            "response_schema_invalid"
        );

        let markdown = r#"{"status":"ok","requestId":"desktop-2","data":{"provider":"gateway","upstreamProvider":"gemini","resultType":"sentenceTranslation","skillVersion":"sentence-translation-v1.1","translation":"**无效译文**","keyTerm":null}}"#;
        let client = GatewayClient::new(FakeTransport::response(200, markdown));
        assert_eq!(
            client
                .send_language("token", &request)
                .unwrap_err()
                .error_code,
            "response_schema_invalid"
        );
        assert!(contains_markdown("`code`"));
        assert!(contains_markdown("\n- item"));
        assert!(!contains_markdown("普通中文译文"));

        let key_term_markdown = r#"{"status":"ok","requestId":"desktop-2","data":{"provider":"gateway","upstreamProvider":"gemini","resultType":"sentenceTranslation","skillVersion":"sentence-translation-v1.1","translation":"有效译文","keyTerm":{"term":"`code`","meaning":"说明"}}}"#;
        let client = GatewayClient::new(FakeTransport::response(200, key_term_markdown));
        assert_eq!(
            client
                .send_language("token", &request)
                .unwrap_err()
                .error_code,
            "response_schema_invalid"
        );
    }

    #[test]
    fn word_rejects_empty_fields_and_invalid_part_of_speech() {
        let request =
            build_language_request(&target(RequestType::WordAnalysis), "desktop-1".into()).unwrap();
        for analysis in [
            r#"{"word":"sample","lemma":"","phonetic":"/sample/","partOfSpeech":"n.","meaning":"示例"}"#,
            r#"{"word":"sample","lemma":"sample","phonetic":"/sample/","partOfSpeech":"noun","meaning":"示例"}"#,
        ] {
            let body = format!(
                r#"{{"status":"ok","requestId":"desktop-1","data":{{"provider":"gateway","upstreamProvider":"gemini","resultType":"contextAnalysis","skillVersion":"context-analysis-v6","analysisMode":"quick","analysis":{analysis}}}}}"#
            );
            let client = GatewayClient::new(FakeTransport::response(200, &body));
            assert_eq!(
                client
                    .send_language("token", &request)
                    .unwrap_err()
                    .error_code,
                "response_schema_invalid"
            );
        }
    }
}
