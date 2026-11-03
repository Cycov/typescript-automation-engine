/**
 * Provider factory: Claude goes through the Anthropic SDK, the rest through
 * the OpenAI-compatible client.
 */

import { AIConfig, ProviderId } from "./config";
import { AnthropicChat, AnthropicCompletion, listAnthropicModels } from "./anthropic";
import { OpenAICompatibleChat, OpenAICompatibleCompletion, OpenAICompatibleId, listOpenAICompatibleModels } from "./openai-compatible";
import { ChatProvider, CompletionProvider, ProviderError } from "./types";

const chatProviders = new Map<string, ChatProvider>();
const completionProviders = new Map<string, CompletionProvider>();

function cacheKey(config: AIConfig, model: string): string {
  return `${config.provider}\u0000${model}\u0000${config.apiKey}`;
}

export function createChatProvider(config: AIConfig, model: string): ChatProvider {
  const key = cacheKey(config, model);
  let provider = chatProviders.get(key);
  if (!provider) {
    if (config.provider === "none") throw new ProviderError("AI provider is not set");
    provider =
      config.provider === "anthropic"
        ? new AnthropicChat(config.apiKey, model)
        : new OpenAICompatibleChat(config.provider, config.apiKey, model);
    chatProviders.clear(); //< only the current settings matter
    chatProviders.set(key, provider);
  }
  return provider;
}

export function createCompletionProvider(config: AIConfig, model: string): CompletionProvider {
  const key = cacheKey(config, model);
  let provider = completionProviders.get(key);
  if (!provider) {
    if (config.provider === "none") throw new ProviderError("AI provider is not set");
    provider =
      config.provider === "anthropic"
        ? new AnthropicCompletion(config.apiKey, model)
        : new OpenAICompatibleCompletion(config.provider, config.apiKey, model);
    completionProviders.clear();
    completionProviders.set(key, provider);
  }
  return provider;
}

export async function listModels(provider: ProviderId, apiKey: string): Promise<string[]> {
  if (provider === "none") return [];
  if (!apiKey) throw new ProviderError("Enter an API key first");
  if (provider === "anthropic") return listAnthropicModels(apiKey);
  return listOpenAICompatibleModels(provider as OpenAICompatibleId, apiKey);
}
