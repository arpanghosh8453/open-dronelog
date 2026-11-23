//! Per-round accounting. Prices are estimates, never a substitute for the provider invoice.
use super::types::ConnectionSettings;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TokenPricing {
    pub input_per_million: f64,
    pub output_per_million: f64,
    #[serde(default)]
    pub cached_input_per_million: Option<f64>,
    #[serde(default)]
    pub cache_write_per_million: Option<f64>,
}
impl TokenPricing {
    pub fn validate(&self) -> Result<(), String> {
        if [
            Some(self.input_per_million),
            Some(self.output_per_million),
            self.cached_input_per_million,
            self.cache_write_per_million,
        ]
        .into_iter()
        .flatten()
        .any(|v| !v.is_finite() || !(0.0..=1_000_000.0).contains(&v))
        {
            return Err(
                "Token prices must be finite, non-negative USD amounts per million tokens".into(),
            );
        }
        Ok(())
    }
}
// Standard short-context text rates verified 2026-11-23. Exact model IDs only;
// dated snapshots are enumerated, so similarly named/custom/fine-tuned models never inherit rates.
// https://developers.openai.com/api/docs/pricing
// https://developers.openai.com/api/docs/models/gpt-5.2
// https://developers.openai.com/api/docs/models/gpt-4o-mini
fn catalog(model: &str) -> Option<TokenPricing> {
    let (input, output, cached, writes) = match model {
        "gpt-6.2-astra" => (8.0, 40.0, 0.4, true),
        "gpt-6.2-sol" | "gpt-6.1-sol" => (2.0, 10.0, 0.1, true),
        "gpt-6-astra" => (10.0, 50.0, 1.0, true),
        "gpt-5.2" | "gpt-5.2-2025-12-11" => (1.75, 14.0, 0.175, false),
        "gpt-4o-mini" | "gpt-4o-mini-2024-07-18" => (0.15, 0.6, 0.075, false),
        _ => return None,
    };
    Some(TokenPricing {
        input_per_million: input,
        output_per_million: output,
        cached_input_per_million: Some(cached),
        cache_write_per_million: writes.then_some(input * 1.25),
    })
}
fn amount(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str()?.parse().ok())
        .filter(|n| n.is_finite() && *n >= 0.0)
}
/// Normalized accounting is stored with the response, including model/rate provenance.
/// Missing rounds are explicit; UI must not turn unknown charges into zero.
pub fn account(c: &ConnectionSettings, raw: Value) -> Value {
    let input = raw["input_tokens"]
        .as_u64()
        .or_else(|| raw["prompt_tokens"].as_u64());
    let output = raw["output_tokens"]
        .as_u64()
        .or_else(|| raw["completion_tokens"].as_u64());
    let details = if raw["input_tokens_details"].is_object() {
        &raw["input_tokens_details"]
    } else {
        &raw["prompt_tokens_details"]
    };
    let cached = details["cached_tokens"].as_u64().unwrap_or(0);
    let writes = details["cache_write_tokens"].as_u64().unwrap_or(0);
    let openrouter = reqwest::Url::parse(&c.base_url)
        .ok()
        .is_some_and(|u| u.host_str() == Some("openrouter.ai"));
    let reported = amount(&raw["cost_usd"]).map(|v| (v, "USD")).or_else(|| {
        if openrouter {
            amount(&raw["cost"]).map(|v| (v, "credits"))
        } else {
            None
        }
    });
    let rates = c.pricing.clone().or_else(|| {
        if c.provider == "openai" {
            catalog(&c.model)
        } else {
            None
        }
    });
    let estimate = rates.as_ref().and_then(|p| {
        let (input, output) = (input?, output?);
        let ordinary = input.checked_sub(cached)?.checked_sub(writes)?;
        // Unknown cache lifetime / non-standard tier / large-context rates are not guessed.
        if c.pricing.is_none()
            && (input > 272_000
                || raw["service_tier"]
                    .as_str()
                    .is_some_and(|s| !["default", "standard", "auto"].contains(&s)))
        {
            return None;
        }
        if details["cache_write_tokens_details"]["ttl_12h_tokens"]
            .as_u64()
            .unwrap_or(0)
            > 0
        {
            return None;
        }
        let cache_rate = if cached == 0 {
            0.0
        } else {
            p.cached_input_per_million
                .or((p.input_per_million == 0.0).then_some(0.0))?
        };
        let write_rate = if writes == 0 {
            0.0
        } else {
            p.cache_write_per_million
                .or((p.input_per_million == 0.0).then_some(0.0))?
        };
        let value = (ordinary as f64 * p.input_per_million
            + output as f64 * p.output_per_million
            + cached as f64 * cache_rate
            + writes as f64 * write_rate)
            / 1_000_000.0;
        value.is_finite().then_some(value)
    });
    let (cost, currency, kind) = match reported {
        Some((v, currency)) => (Some(v), currency, "reported"),
        None => (
            estimate,
            "USD",
            if estimate.is_some() {
                "estimated"
            } else {
                "unavailable"
            },
        ),
    };
    json!({"input_tokens":input,"output_tokens":output,"cached_tokens":cached,"cost":cost,"currency":currency,"cost_kind":kind,"model":c.model,"pricing_source":if reported.is_some(){"provider"}else if c.pricing.is_some(){"custom"}else if rates.is_some(){"catalog_2026-11-23"}else{"unknown"},"rates":rates,"provider_usage":raw})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accounting_counts_cache_and_output_once_and_never_guesses_unknown_prices() {
        let c = ConnectionSettings {
            provider: "openai".into(),
            model: "gpt-5.2".into(),
            ..Default::default()
        };
        let v = account(
            &c,
            json!({"input_tokens":1000,"output_tokens":100,"input_tokens_details":{"cached_tokens":400},"output_tokens_details":{"reasoning_tokens":80}}),
        );
        assert!((v["cost"].as_f64().unwrap() - 0.00252).abs() < 1e-12);
        assert_eq!(v["cost_kind"], "estimated");
        assert!(account(&c, Value::Null)["cost"].is_null());
        let custom = ConnectionSettings {
            provider: "custom".into(),
            model: "gpt-5.2".into(),
            ..Default::default()
        };
        assert!(account(
            &custom,
            json!({"prompt_tokens":1000,"completion_tokens":100})
        )["cost"]
            .is_null());
        let paid = account(&custom, json!({"cost_usd":0.007}));
        assert_eq!(paid["cost"], 0.007);
        assert_eq!(paid["cost_kind"], "reported");
        let free = ConnectionSettings {
            pricing: Some(TokenPricing {
                input_per_million: 0.0,
                output_per_million: 0.0,
                cached_input_per_million: Some(0.0),
                cache_write_per_million: None,
            }),
            ..custom
        };
        assert_eq!(
            account(&free, json!({"prompt_tokens":1000,"completion_tokens":100}))["cost"],
            0.0
        );
        assert_eq!(
            account(
                &free,
                json!({"prompt_tokens":1000,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":500,"cache_write_tokens":100}})
            )["cost"],
            0.0
        );
        assert!(account(
            &c,
            json!({"input_tokens":1000,"output_tokens":100,"service_tier":"priority"})
        )["cost"]
            .is_null());
        assert!(account(&c,json!({"input_tokens":100,"output_tokens":10,"input_tokens_details":{"cached_tokens":200}}))["cost"].is_null());
        let router = ConnectionSettings {
            base_url: "https://openrouter.ai/api/v1".into(),
            ..Default::default()
        };
        let reported = account(&router, json!({"cost":0.0003}));
        assert_eq!(reported["currency"], "credits");
        assert_eq!(reported["cost_kind"], "reported");
        assert!(TokenPricing {
            input_per_million: -1.0,
            output_per_million: 0.0,
            cached_input_per_million: None,
            cache_write_per_million: None
        }
        .validate()
        .is_err());
    }
}
