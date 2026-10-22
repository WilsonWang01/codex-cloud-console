export function modelApiProtocol(path) {
  const match = /^\/api\/automations\/[^/]+\/v1\/(chat\/completions|messages|responses|images\/generations)$/.exec(path);
  return match ? { messages: "anthropic", responses: "responses", "images/generations": "images", "chat/completions": "openai" }[match[1]] : null;
}
