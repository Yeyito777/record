import { isAbsolute, join } from "node:path";

export interface RecordWhatsAppPaths {
  /** $XDG_CONFIG_HOME/record/whatsapp (or ~/.config/record/whatsapp). */
  directory: string;
  /** Record-owned Baileys state. It never points at whatsapp-cli's config. */
  authDirectory: string;
}

export type WhatsAppPathEnvironment = Readonly<Record<string, string | undefined>>;

export function getRecordWhatsAppPaths(
  env: WhatsAppPathEnvironment = process.env,
): RecordWhatsAppPaths {
  const configuredHome = env.XDG_CONFIG_HOME?.trim();
  let configHome: string;

  if (configuredHome) {
    if (!isAbsolute(configuredHome)) {
      throw new Error("XDG_CONFIG_HOME must be an absolute path.");
    }
    configHome = configuredHome;
  } else {
    const home = env.HOME?.trim();
    if (!home) {
      throw new Error("Could not resolve Record's WhatsApp config directory.");
    }
    if (!isAbsolute(home)) {
      throw new Error("HOME must be an absolute path.");
    }
    configHome = join(home, ".config");
  }

  const directory = join(configHome, "record", "whatsapp");
  return {
    directory,
    authDirectory: join(directory, "auth"),
  };
}
