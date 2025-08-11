const https = require('https');
const { geminiApiKey, API_DELAY, MAX_RETRIES, GEMINI_DEBOUNCE_MS } = require('../config/config');
const { log, delay } = require('../utils/logger');

// In-memory cache for API responses to avoid duplicate calls
const geminiCache = {};
// Debounce tracker to prevent rapid repeated calls
const geminiDebounce = {};

async function callGeminiAPI(prompt, retries = 0) {
  // Check cache first
  if (geminiCache[prompt]) {
    return Promise.resolve(geminiCache[prompt]);
  }
  
  // Debounce: if a call for this prompt is in progress, return the same promise
  if (geminiDebounce[prompt]) {
    return geminiDebounce[prompt];
  }
  
  // Wrap the actual API call in a promise and store it in debounce tracker
  const apiPromise = new Promise((resolve, reject) => {
    const data = JSON.stringify({
      contents: [{ 
        parts: [{ text: prompt }] 
      }],
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 2048
      }
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      port: 443,
      path: `/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${geminiApiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(responseData);
          if (response.error) {
            if (retries < MAX_RETRIES) {
              // Exponential backoff: delay doubles with each retry
              const backoff = Math.pow(2, retries) * 1000; // 1s, 2s, 4s
              log(`⚠️ API Error (retry ${retries + 1}/${MAX_RETRIES}, waiting ${backoff / 1000}s): ${response.error.message}`, 'yellow');
              setTimeout(() => {
                callGeminiAPI(prompt, retries + 1).then(resolve).catch(reject);
              }, backoff);
              return;
            }
            reject(new Error(response.error.message));
            return;
          }
          const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            geminiCache[prompt] = text; // Cache the result
            resolve(text);
          } else {
            reject(new Error('Unexpected response format'));
          }
        } catch (err) {
          if (retries < MAX_RETRIES) {
            const backoff = Math.pow(2, retries) * 1000; // 1s, 2s, 4s
            log(`⚠️ Parse Error (retry ${retries + 1}/${MAX_RETRIES}, waiting ${backoff / 1000}s): ${err.message}`, 'yellow');
            setTimeout(() => {
              callGeminiAPI(prompt, retries + 1).then(resolve).catch(reject);
            }, backoff);
            return;
          }
          reject(err);
        }
      });
    });

    req.on('error', (err) => {
      if (retries < MAX_RETRIES) {
        const backoff = Math.pow(2, retries) * 1000; // 1s, 2s, 4s
        log(`⚠️ Request Error (retry ${retries + 1}/${MAX_RETRIES}, waiting ${backoff / 1000}s): ${err.message}`, 'yellow');
        setTimeout(() => {
          callGeminiAPI(prompt, retries + 1).then(resolve).catch(reject);
        }, backoff);
        return;
      }
      reject(err);
    });

    req.setTimeout(30000);
    req.write(data);
    req.end();
  });
  
  // Store the promise in debounce tracker
  geminiDebounce[prompt] = apiPromise;
  
  // After debounce window, clear the tracker for this prompt
  setTimeout(() => {
    delete geminiDebounce[prompt];
  }, GEMINI_DEBOUNCE_MS);
  
  return apiPromise;
}

module.exports = {
  callGeminiAPI
}; 