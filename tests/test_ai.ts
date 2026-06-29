import * as dotenv from 'dotenv';
import axios from 'axios';
import path from 'path';

// Load the environment variables from the workspace .env file
dotenv.config({ path: '/home/gvnaap/Documents/infra/.env' });

const providers = [
    {
        name: 'OpenRouter',
        url: process.env.OPENROUTER_URL,
        apiKey: process.env.OPENROUTER_API_KEY,
        model: process.env.OPENROUTER_MODEL
    },
    {
        name: 'Gemini',
        url: process.env.GEMINI_URL,
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL
    },
    {
        name: 'Groq',
        url: process.env.GROQ_URL,
        apiKey: process.env.GROQ_API_KEY,
        model: process.env.GROQ_MODEL
    },
    {
        name: 'Mistral',
        url: process.env.MISTRAL_URL,
        apiKey: process.env.MISTRAL_API_KEY,
        model: process.env.MISTRAL_MODEL
    }
];

const prompt = `
SYSTEM ROLE:
You are the operational intelligence for a Solana transaction observatory (CHRONOS).
You observe current network conditions and decide when to submit bundles, how much to tip, and whether failed transactions should be retried.
You must respond only with a valid JSON block.

YOUR DECISION:
Decide on one of the actions: SUBMIT, HOLD, RETRY, SKIP.
Respond ONLY with a valid JSON block of this format:
{
  "action": "SUBMIT",
  "tip": 10000,
  "waitDuration": 1,
  "reasoning": "testing endpoint connection"
}
`;

async function runTests() {
    console.log('--- Testing AI Providers ---');
    for (const provider of providers) {
        console.log(`\nTesting Provider: ${provider.name}`);
        console.log(`URL: ${provider.url}`);
        console.log(`Model: ${provider.model}`);
        console.log(`API Key (truncated): ${provider.apiKey ? provider.apiKey.substring(0, 10) + '...' : 'undefined'}`);

        if (!provider.url || !provider.apiKey || !provider.model) {
            console.log(`❌ Skipped: Missing configuration.`);
            continue;
        }

        try {
            const response = await axios.post(
                provider.url,
                {
                    model: provider.model,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.3,
                    max_tokens: 150,
                    response_format: { type: 'json_object' }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${provider.apiKey}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': 'https://github.com/google/antigravity',
                        'X-Title': 'Chronos Observatory'
                    },
                    timeout: 15000
                }
            );

            console.log(`✅ Success! Status code: ${response.status}`);
            console.log(`Response data:`, JSON.stringify(response.data, null, 2));
        } catch (error: any) {
            console.error(`❌ Failed: ${error.message}`);
            if (error.response) {
                console.error(`Status code: ${error.response.status}`);
                console.error(`Response data:`, JSON.stringify(error.response.data, null, 2));
            }
        }
    }
}

runTests();

