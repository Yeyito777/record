import { VOICE_REGION_TIMEOUT_MS } from "./constants";
import { isObject } from "./util";

let cachedPreferredVoiceRegions: string[] | null = null;

export async function fetchPreferredVoiceRegions(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  if (fetchImpl === fetch && cachedPreferredVoiceRegions) return cachedPreferredVoiceRegions;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VOICE_REGION_TIMEOUT_MS);
  try {
    const response = await fetchImpl("https://latency.discord.media/rtc", {
      method: "GET",
      headers: { "Accept": "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const regions = await response.json() as unknown;
    if (!Array.isArray(regions)) return [];
    const preferred = regions
      .map((region) => isObject(region) && typeof region.region === "string" ? region.region : null)
      .filter((region): region is string => Boolean(region));
    if (fetchImpl === fetch && preferred.length > 0) cachedPreferredVoiceRegions = preferred;
    return preferred;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
