// Gemini API response fixtures.
//
// CAPTURED_* payloads were captured verbatim from generativelanguage.googleapis.com on
// 2026-11-04 (no valid key was available, so only failure paths could be captured).
// DOC_* payloads are synthesized from the documented GenerateContentResponse schema
// (Discovery revision 20261103) and the standard google.rpc error detail types.

const CAPTURED_INVALID_KEY_400 = {
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'API_KEY_INVALID',
        domain: 'googleapis.com',
        metadata: { service: 'generativelanguage.googleapis.com' }
      },
      {
        '@type': 'type.googleapis.com/google.rpc.LocalizedMessage',
        locale: 'en-US',
        message: 'API key not valid. Please pass a valid API key.'
      }
    ]
  }
};

const CAPTURED_UNKNOWN_FIELD_400 = {
  error: {
    code: 400,
    message: 'Invalid JSON payload received. Unknown name "contentz": Cannot find field.',
    status: 'INVALID_ARGUMENT',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.BadRequest',
        fieldViolations: [{ description: 'Invalid JSON payload received. Unknown name "contentz": Cannot find field.' }]
      }
    ]
  }
};

const CAPTURED_UNREGISTERED_403 = {
  error: {
    code: 403,
    message: "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.",
    status: 'PERMISSION_DENIED'
  }
};

const DOC_MODEL_NOT_FOUND_404 = {
  error: {
    code: 404,
    message: 'models/gemini-2.0-flash-exp is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.',
    status: 'NOT_FOUND'
  }
};

const DOC_RATE_LIMIT_429 = {
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-flash-latest\nPlease retry in 41.62s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{
          quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
          quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
          quotaDimensions: { location: 'global', model: 'gemini-flash-latest' },
          quotaValue: '10'
        }]
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41s' }
    ]
  }
};

const DOC_DAILY_QUOTA_429 = {
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 250, model: gemini-flash-latest',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{
          quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
          quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
          quotaValue: '250'
        }]
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7200s' }
    ]
  }
};

const DOC_ZERO_LIMIT_429 = {
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-pro-latest',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '0' }]
      }
    ]
  }
};

const DOC_OVERLOADED_503 = {
  error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' }
};

function docSuccess(text, { finishReason = 'STOP', thought, extraParts } = {}) {
  const parts = [];
  if (thought) parts.push({ text: thought, thought: true });
  parts.push({ text });
  if (extraParts) parts.push(...extraParts);
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason, index: 0 }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
    modelVersion: 'gemini-flash-latest',
    responseId: 'test-response'
  };
}

const DOC_BLOCKED_PROMPT = { promptFeedback: { blockReason: 'SAFETY' } };

const DOC_THINKING_ONLY_MAX_TOKENS = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'thinking...', thought: true }] }, finishReason: 'MAX_TOKENS' }]
};

module.exports = {
  CAPTURED_INVALID_KEY_400,
  CAPTURED_UNKNOWN_FIELD_400,
  CAPTURED_UNREGISTERED_403,
  DOC_MODEL_NOT_FOUND_404,
  DOC_RATE_LIMIT_429,
  DOC_DAILY_QUOTA_429,
  DOC_ZERO_LIMIT_429,
  DOC_OVERLOADED_503,
  DOC_BLOCKED_PROMPT,
  DOC_THINKING_ONLY_MAX_TOKENS,
  docSuccess
};
