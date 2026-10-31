// Musique Instagram (API Audio de Meta) : nécessite une connexion Instagram via Facebook Login.
// Les jetons sont rangés dans hub_tokens : « igm » (jeton utilisateur, 60 jours) et « igm_page » (jeton de Page, permanent).
export const GFB = "https://graph.facebook.com/v25.0";
export const APP_ID = "1097607972871605";

export class IgmError extends Error {}

async function call(method: "GET" | "POST", url: string, params: Record<string, string>): Promise<any> {
  const res = method === "GET"
    ? await fetch(url + "?" + new URLSearchParams(params))
    : await fetch(url, { method: "POST", body: new URLSearchParams(params) });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { throw new IgmError(`Réponse illisible de Meta (${res.status})`); }
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new IgmError(e.error_user_msg || e.message || `Erreur Meta ${res.status}`);
  }
  return json;
}
export const fget = (path: string, p: Record<string, string>) => call("GET", GFB + path, p);
export const fpost = (path: string, p: Record<string, string>) => call("POST", GFB + path, p);

/** Jeton à utiliser : le jeton utilisateur s'il est encore valable, sinon le jeton de Page (permanent). */
export function pickToken(toks: Record<string, any>): string | null {
  const u = toks.igm;
  if (u && (!u.expires_at || new Date(u.expires_at).getTime() > Date.now() + 3600e3)) return u.access_token;
  return toks.igm_page?.access_token || null;
}

/** Recherche de musiques Instagram (tendances si pas de recherche). */
export async function searchAudio(token: string, igUserId: string, q?: string) {
  const params: Record<string, string> = { audio_type: "music", user_id: igUserId, access_token: token };
  if (q) params.search_query = q.slice(0, 100);
  const r = await fget("/ig_audio", params);
  const list: any[] = Array.isArray(r) ? r : (r.data || r.audio || r.results || []);
  return list.map((a) => ({
    id: String(a.audio_id || a.id),
    title: a.title || "Sans titre",
    artist: a.display_artist || a.ig_username || "",
    duration: a.duration_in_ms ? Math.round(a.duration_in_ms / 1000) : null,
    cover: a.cover_artwork_thumbnail_uri || a.cover_artwork_thumbnail_url || null,
    preview: a.download_url || null,
    link: a.on_platform_audio_preview_link || null,
  }));
}

/** Attend qu'un conteneur soit prêt. true = FINISHED. */
export async function waitFinished(id: string, token: string, maxMs: number): Promise<boolean> {
  const end = Date.now() + maxMs;
  while (true) {
    const s = await fget(`/${id}`, { fields: "status_code,status", access_token: token });
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new IgmError("Instagram a refusé la vidéo : " + (s.status || "format, taille ou durée non acceptés"));
    if (s.status_code === "FINISHED") return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Volume du son d'origine de la vidéo selon le choix du hub. */
export const VIDEO_VOL: Record<string, number> = { couper: 1, faible: 25, garder: 100 };
