export function providerIcon(provider, size = 28) {
  const icon = document.createElement("img");
  const id = ["gpt", "claude", "gemini", "grok"].includes(provider)
    ? provider
    : "gpt";
  icon.src = `assets/provider-${id}.svg`;
  icon.width = icon.height = size;
  icon.alt = "";
  icon.className = "provider-logo provider-logo-" + id;
  return icon;
}
